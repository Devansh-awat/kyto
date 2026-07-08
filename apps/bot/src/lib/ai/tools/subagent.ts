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
import type { KytoBot, Message, ThreadHandle } from '@/harness';
import { requestHints } from '@/lib/ai/hints';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

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
            system: systemPrompt({ hints }),
            tools: built.tools,
          });
          const report = (await result.text).trim();
          if (report) {
            return { report, success: true };
          }
          const toolCalls = await result.toolCalls;
          if (toolCalls.length > 0) {
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
