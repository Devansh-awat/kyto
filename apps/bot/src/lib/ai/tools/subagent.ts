import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type SandboxContext,
  streamAttempt,
  subagentAttempt,
  systemPrompt,
} from '@repo/ai';
import { LazySandbox } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { KytoBot, Message, StreamChunk, ThreadHandle } from '@/harness';
import { requestHints } from '@/lib/ai/hints';
import { resolveIdentity } from '@/lib/identity';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';

// A subagent is a headless copy of kyto: its own fresh lazy sandbox, the same
// full toolset (including this very tool, so it can delegate further), running
// the standard system prompt — but pinned to a cheap model (Gemini flash-lite,
// else the best DigitalOcean BYOK model) and NOT streamed to Slack. It runs the
// same multi-step tool loop as a normal turn (streamAttempt drives it
// internally) and returns only its final text as a report. Use it for
// open-ended investigation or self-contained work that would otherwise clutter
// the caller's context.
//
// Recursion is capped via AsyncLocalStorage — a runaway recursive spawn would
// otherwise be a real cost/time risk with no natural backstop.
const MAX_SUBAGENT_DEPTH = 2;

const depthStore = new AsyncLocalStorage<number>();

// Bounds on the live subagent card so a long run can't blow up the plan card.
const CARD_THINKING_MAX = 2000;
const CARD_REPORT_MAX = 2000;
const CARD_TASK_MAX = 400;

// Compose the expanded body of the "Subagent" plan card: the task it was given,
// its running thoughts, which tools it has called (names only — never their
// outputs, per the owner), and its report once finished.
function renderCard({
  report,
  task,
  thinking,
  toolsUsed,
}: {
  report: string;
  task: string;
  thinking: string;
  toolsUsed: string[];
}): string {
  const parts = [`Task: ${clamp(task, CARD_TASK_MAX) ?? task}`];
  if (thinking.trim()) {
    parts.push(
      '',
      `Thinking: ${clamp(thinking.trim(), CARD_THINKING_MAX) ?? thinking.trim()}`
    );
  }
  if (toolsUsed.length > 0) {
    parts.push('', `Tools used: ${toolsUsed.join(', ')}`);
  }
  if (report.trim()) {
    parts.push(
      '',
      `Report: ${clamp(report.trim(), CARD_REPORT_MAX) ?? report.trim()}`
    );
  }
  return parts.join('\n');
}

export function runSubagentTool({
  bot,
  emitChunk,
  message,
  thread,
}: {
  bot: KytoBot;
  emitChunk?: (chunk: StreamChunk) => void;
  message: Message;
  thread: ThreadHandle;
}) {
  return tool({
    description:
      'Delegate a task to a subagent — a headless copy of kyto (its own sandbox, same tools, can even delegate further) that runs on a cheaper pinned model and returns a written report. Use it for open-ended investigation or self-contained work that would otherwise clutter your own context. It has NO access to this conversation beyond what you put in the task.',
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .describe(
          'The task to delegate, with as much detail/context as the subagent will need.'
        ),
    }),
    execute: async ({ task }, { abortSignal }) => {
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
        let close: (() => Promise<void>) | undefined;
        // A single live card in the parent plan tracks this subagent's work.
        const cardId = `subagent-${crypto.randomUUID()}`;
        // The subagent's configured name (base "kyto" + suffix) titles its card;
        // an icon can't render on a plan card, so only the name applies here.
        const identity = await resolveIdentity('subagent');
        const cardTitle = identity.username ?? 'Subagent';
        const toolsUsed: string[] = [];
        let thinking = '';
        let report = '';
        const pushCard = (status: 'complete' | 'error' | 'in_progress') => {
          emitChunk?.({
            id: cardId,
            output: renderCard({ report, task, thinking, toolsUsed }),
            status,
            title: cardTitle,
            type: 'task_update',
          });
        };
        try {
          const hints = await requestHints({ message, thread });
          // The subagent must NOT spawn its own plan cards in the parent plan.
          const built = await buildTools({
            bot,
            getSandboxContext: () => sandboxContext,
            message,
            thread,
          });
          close = built.close;
          pushCard('in_progress');
          const result = streamAttempt({
            abortSignal,
            activeTools: built.activeTools,
            attempt,
            holder: {},
            prompt: task,
            system: systemPrompt({ hints }),
            tools: built.tools,
          });
          // Consume the subagent's own stream to surface its thinking + the
          // tools it calls (names only) live, and to accumulate its report.
          for await (const part of result.fullStream) {
            if (part.type === 'reasoning-delta') {
              thinking += part.text;
            } else if (part.type === 'text-delta') {
              report += part.text;
            } else if (part.type === 'tool-call') {
              toolsUsed.push(part.toolName);
              pushCard('in_progress');
            }
          }
          report = report.trim();
          if (report) {
            pushCard('complete');
            return { report, success: true };
          }
          if (toolsUsed.length > 0) {
            report = '(Completed actions with no additional message.)';
            pushCard('complete');
            return { report, success: true };
          }
          pushCard('error');
          return {
            error: 'Subagent produced an empty report.',
            success: false,
          };
        } catch (error) {
          pushCard('error');
          return { error: errorMessage(error), success: false };
        } finally {
          await close?.().catch(() => undefined);
          await sandboxSession.destroy().catch(() => undefined);
        }
      });
    },
  });
}
