import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type SandboxContext,
  streamAttempt,
  subagentAttempt,
  subagentSystemPrompt,
} from '@repo/ai';
import { LazySandbox } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { KytoBot, Message, StreamChunk, ThreadHandle } from '@/harness';
import { requestHints } from '@/lib/ai/hints';
import { slack } from '@/lib/chat';
import { resolveIdentity } from '@/lib/identity';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';

// A subagent is a headless copy of kyto: its own fresh lazy sandbox, the same
// full toolset (including this very tool, so it can delegate further), pinned to
// a cheap model (Gemini flash-lite, else the best DigitalOcean BYOK model). It
// runs the same multi-step tool loop as a normal turn (streamAttempt drives it)
// and returns its final text as a report to the parent.
//
// Its work is surfaced as ITS OWN streamed Slack message, posted under kyto's
// bot but with the display name "kyto subagent" (+ optional name), showing a
// collapsible plan (task, tools called) and its response as the message body —
// so it reads as a distinct agent, not folded into the parent's plan.
//
// Recursion is capped via AsyncLocalStorage — a runaway recursive spawn would
// otherwise be a real cost/time risk with no natural backstop.
const MAX_SUBAGENT_DEPTH = 2;

const depthStore = new AsyncLocalStorage<number>();

// Bounds on the single subagent card so a long run can't blow up the message.
const CARD_TASK_MAX = 500;
const CARD_THINKING_MAX = 700;
const CARD_REPORT_MAX = 2000;
const CARD_TITLE_MAX = 80;
const CARD_MAX_STEPS = 24;

// One step of the subagent's run, in the order it happened: a stretch of
// reasoning, or a tool call.
export type SubagentStep =
  | { text: string; type: 'thinking' }
  | { toolName: string; type: 'tool' };

// Compose the ONE collapsible card the subagent posts: its prompt, then its run
// as a CHRONOLOGICAL timeline (thinking → tool → more thinking → tool …), then
// its response — all inside the single expandable block, nothing in the message
// body. Reading it back should tell you what the subagent did, in order; a
// thinking blob followed by a bare list of tool names does not.
//
// Slack takes a task's `output` ONCE, on the update that completes it: sending
// it on an in_progress update froze the card at whatever it held then (just the
// prompt, since nothing else had happened yet) and every later update was
// ignored. So the full body is only ever sent on the completing update — the
// same shape every other task in the plan uses.
function renderCard({
  report,
  steps,
  task,
}: {
  report: string;
  steps: SubagentStep[];
  task: string;
}): string {
  const parts = [`Prompt: ${clamp(task, CARD_TASK_MAX) ?? task}`];
  // Keep the most RECENT steps when a long run overflows: the tail is what led
  // to the response, and the prompt above already says where it started.
  const shown = steps.slice(-CARD_MAX_STEPS);
  const dropped = steps.length - shown.length;
  if (dropped > 0) {
    parts.push('', `…${dropped} earlier step(s) omitted`);
  }
  for (const step of shown) {
    parts.push(
      '',
      step.type === 'tool'
        ? `Tool: ${step.toolName}`
        : `Thinking: ${clamp(step.text, CARD_THINKING_MAX) ?? step.text}`
    );
  }
  if (report.trim()) {
    parts.push(
      '',
      `Response: ${clamp(report.trim(), CARD_REPORT_MAX) ?? report.trim()}`
    );
  }
  return parts.join('\n');
}

export function runSubagentTool({
  bot,
  message,
  thread,
}: {
  bot: KytoBot;
  message: Message;
  thread: ThreadHandle;
}) {
  return tool({
    description:
      'Delegate a task to a subagent — a headless copy of kyto (its own sandbox, same tools, can even delegate further) that runs on a cheaper pinned model and posts its own "kyto subagent" message with its findings, then returns a written report to you. Use it for open-ended investigation or self-contained work that would otherwise clutter your own context. It has NO access to this conversation beyond what you put in the task.',
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .describe(
          'The task to delegate, with as much detail/context as the subagent will need.'
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Optional short name for this subagent (e.g. "researcher"), shown in its message as "kyto subagent {name}".'
        ),
    }),
    execute: async ({ task, name }, { abortSignal }) => {
      const attempt = subagentAttempt;
      if (!attempt) {
        return {
          error:
            'No subagent model is configured (needs GEMINI_API_KEY or OPENROUTER_API_KEY).',
          success: false,
        };
      }
      const depth = depthStore.getStore() ?? 0;
      if (depth >= MAX_SUBAGENT_DEPTH) {
        return {
          error: `Subagent nesting limit (${MAX_SUBAGENT_DEPTH}) reached — cannot delegate further.`,
          success: false,
        };
      }
      return await depthStore.run(depth + 1, async () => {
        // A fresh lazy sandbox, distinct from the caller's — materializes only
        // if the subagent actually uses a sandbox tool, destroyed at the end.
        const sandboxSession = new LazySandbox({
          apiKey: env.E2B_API_KEY,
          githubToken: env.GH_TOKEN,
          logger,
          sessionId: `${thread.id}-subagent-${crypto.randomUUID()}`,
        });
        const sandboxContext: SandboxContext = {
          session: sandboxSession,
          sessionWorkDir: sandboxSession.workDir,
        };
        // Lazy import breaks the cycle: toolset.ts registers this tool, and
        // this tool needs toolset.ts's buildTools to give the subagent its own
        // full set (recursion is bounded by the depth cap above).
        const { buildTools } = await import('@/lib/ai/toolset');
        // The subagent's identity: base "kyto subagent" (+ optional name),
        // applied to its own streamed message so it reads as a distinct agent.
        const identity = await resolveIdentity('subagent');
        const baseName = identity.username ?? 'kyto subagent';
        const username = name ? `${baseName} ${name}` : baseName;

        let close: (() => Promise<void>) | undefined;
        const toolsUsed: string[] = [];
        // The run as it happened, so the card can replay it in order.
        const steps: SubagentStep[] = [];
        let report = '';
        // Reasoning arrives as deltas; buffer them until something else (a tool
        // call, or the end of the run) closes off that stretch of thinking.
        let thinking = '';
        const flushThinking = () => {
          const text = thinking.trim();
          thinking = '';
          if (text) {
            steps.push({ text, type: 'thinking' });
          }
        };

        try {
          const hints = await requestHints({ message, thread });
          const built = await buildTools({
            bot,
            getSandboxContext: () => sandboxContext,
            message,
            thread,
          });
          close = built.close;

          const result = streamAttempt({
            abortSignal,
            activeTools: built.activeTools,
            attempt,
            holder: {},
            prompt: task,
            system: subagentSystemPrompt({ hints }),
            tools: built.tools,
          });

          // Drive the subagent's stream into its OWN Slack message: ONE
          // collapsible card (authored as "kyto subagent") whose expanded body
          // holds the prompt, the run in order, and the response. Nothing goes
          // in the message body.
          //
          // The card is yielded exactly TWICE: once to open it, once to complete
          // it. Slack APPENDS a task's `details` on every update rather than
          // replacing it, so re-sending a progress line per tool call stacked up
          // as "Working…Working… 1 tool call(s)…Working… 2 tool call(s)…".
          const cardTitle = clamp(name ?? task, CARD_TITLE_MAX) ?? 'Subagent';
          const opening = (): StreamChunk => ({
            details: 'Working…',
            id: 'subagent',
            status: 'in_progress',
            title: cardTitle,
            type: 'task_update',
          });
          const done = (): StreamChunk => ({
            id: 'subagent',
            output: renderCard({ report, steps, task }),
            status: 'complete',
            title: cardTitle,
            type: 'task_update',
          });
          async function* subagentChunks(): AsyncGenerator<
            string | StreamChunk
          > {
            yield opening();
            for await (const part of result.fullStream) {
              if (part.type === 'text-delta') {
                report += part.text;
              } else if (part.type === 'reasoning-delta') {
                thinking += part.text;
              } else if (part.type === 'tool-call') {
                // Close off the thinking that led to this call, so the card
                // reads thinking → tool → thinking → tool, in order.
                flushThinking();
                toolsUsed.push(part.toolName);
                steps.push({ toolName: part.toolName, type: 'tool' });
              }
            }
            flushThinking();
            yield done();
          }

          await slack.stream(thread.id, subagentChunks(), {
            iconEmoji: identity.iconEmoji,
            iconUrl: identity.iconUrl,
            recipientTeamId: slack.teamId ?? '',
            recipientUserId: message.author.userId,
            taskDisplayMode: 'plan',
            username,
          });

          report = report.trim();
          if (report) {
            return { report, success: true };
          }
          if (toolsUsed.length > 0) {
            return {
              report: '(Completed actions with no additional message.)',
              success: true,
            };
          }
          return {
            error: 'Subagent produced an empty report.',
            success: false,
          };
        } catch (error) {
          return { error: errorMessage(error), success: false };
        } finally {
          await close?.().catch(() => undefined);
          await sandboxSession.destroy().catch(() => undefined);
        }
      });
    },
  });
}
