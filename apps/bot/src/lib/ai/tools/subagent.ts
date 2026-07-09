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

// Bounds on the live plan cards so a long run can't blow up the message.
const CARD_TASK_MAX = 500;
const TOOLS_MAX = 60;

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
        let report = '';

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

          // Drive the subagent's stream into its OWN Slack message (a separate
          // streamed collapsible plan + response, authored as "kyto subagent").
          const taskCard = clamp(task, CARD_TASK_MAX) ?? task;
          async function* subagentChunks(): AsyncGenerator<
            string | StreamChunk
          > {
            yield {
              id: 'task',
              output: `Task: ${taskCard}`,
              status: 'in_progress',
              title: 'Task',
              type: 'task_update',
            };
            for await (const part of result.fullStream) {
              if (part.type === 'text-delta') {
                report += part.text;
                if (part.text) {
                  yield { text: part.text, type: 'markdown_text' };
                }
              } else if (part.type === 'tool-call') {
                toolsUsed.push(part.toolName);
                yield {
                  id: 'tools',
                  output: clamp(toolsUsed.join(', '), TOOLS_MAX) ?? '',
                  status: 'in_progress',
                  title: 'Tools called',
                  type: 'task_update',
                };
              }
            }
            yield {
              id: 'task',
              output: `Task: ${taskCard}`,
              status: 'complete',
              title: 'Task',
              type: 'task_update',
            };
            if (toolsUsed.length > 0) {
              yield {
                id: 'tools',
                output: toolsUsed.join(', '),
                status: 'complete',
                title: 'Tools called',
                type: 'task_update',
              };
            }
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
