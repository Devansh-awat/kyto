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
import { renderStream } from '@/lib/ai/stream';
import { slack } from '@/lib/chat';
import { resolveIdentity } from '@/lib/identity';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// A subagent is a headless copy of kyto: its own fresh lazy sandbox, the same
// full toolset (including this very tool, so it can delegate further), pinned to
// a cheap model (Gemini flash-lite, else the best DigitalOcean BYOK model). It
// runs the same multi-step tool loop as a normal turn (streamAttempt drives it)
// and returns its final text as a report to the parent.
//
// Its work is surfaced as ITS OWN streamed Slack message, posted under kyto's
// bot but with the display name "kyto subagent" (+ optional name). It renders
// EXACTLY like a real turn — the same interleaved thinking/tool cards, in stream
// order — via the shared renderStream, plus a Prompt card and a Model card up
// top and its response streamed into the message body. So it reads as a distinct
// agent that shows its whole run, not a single frozen card.
//
// Recursion is capped via AsyncLocalStorage. Only ONE level deep: a subagent may
// NOT spawn a further subagent (a runaway recursive spawn is a real cost/time
// risk with no natural backstop, and one level is all that's actually useful).
const MAX_SUBAGENT_DEPTH = 1;

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
      'Delegate a task to a subagent — a headless copy of kyto (its own sandbox, same tools) that runs on a cheaper pinned model and posts its own "kyto subagent" message with its findings, then returns a written report to you. Use it for open-ended investigation or self-contained work that would otherwise clutter your own context. It has NO access to this conversation beyond what you put in the task. By default it runs FOREGROUND (you wait for its report, then use it). Set background:true to fire it off and keep working immediately — you get no report back (it posts its own message when done), so only use background when you do NOT need its result to continue.',
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
      background: z
        .boolean()
        .optional()
        .describe(
          'If true, spawn the subagent and return IMMEDIATELY without waiting — it runs independently and posts its own message. You get no report back. Use it to run a side-task in parallel while you continue your own work. Default false (wait for and receive the report).'
        ),
    }),
    execute: async ({ task, name, background }, { abortSignal }) => {
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
      // depthStore.run STARTS the job and returns its promise. Foreground: await
      // it and hand the report back. Background: don't await — the subagent runs
      // on independently (its own sandbox, its own streamed message), so the
      // parent model gets control back this step and can do other work while it
      // runs. It's tied to the parent turn's abort signal, so a user interrupt
      // still stops it, but normal parent completion leaves it running.
      const job = depthStore.run(depth + 1, async () => {
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
        let ranTools = false;
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

          // Drive the subagent's stream into its OWN Slack message, authored as
          // "kyto subagent". EVERYTHING lives inside the ONE collapsible plan —
          // nothing in the message body. It renders like a real turn: a Prompt
          // card (FULL task, unclamped), a Model card, then the SAME interleaved
          // thinking/tool cards a normal turn shows (shared renderStream, in
          // stream order), then a Response card holding the subagent's FULL final
          // reply. No "Working…" placeholder — each card carries its own output.
          const card = (
            id: string,
            title: string,
            status: 'complete' | 'in_progress',
            output?: string
          ): StreamChunk => ({
            id,
            output: status === 'complete' ? (output ?? '') : '',
            status,
            title,
            type: 'task_update',
          });
          // Captured here where `attempt` is narrowed non-null; the nested
          // generator below loses that narrowing.
          const modelName = attempt.model;
          async function* subagentChunks(): AsyncGenerator<
            string | StreamChunk
          > {
            yield card('prompt', 'Prompt', 'in_progress');
            yield card('prompt', 'Prompt', 'complete', task);
            yield card('model', 'Model', 'in_progress');
            yield card('model', 'Model', 'complete', modelName);
            // No emitText: the response is NOT streamed to the body; it's
            // captured here and shown as the Response card below, so the whole
            // run stays inside the single collapsible block.
            yield* renderStream({
              knownTools: new Set(Object.keys(built.tools)),
              onTextDelta: (text) => {
                report += text;
              },
              onToolActivity: () => {
                ranTools = true;
              },
              stream: result.fullStream,
            });
            const finalReport = report.trim();
            if (finalReport || ranTools) {
              yield card('response', 'Response', 'in_progress');
              yield card(
                'response',
                'Response',
                'complete',
                finalReport || '(Completed actions with no additional message.)'
              );
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
          if (ranTools) {
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

      if (background) {
        // Detached: log any failure (there's no caller awaiting it), and hand
        // control straight back to the parent model.
        job.catch((error: unknown) => {
          logger.error(
            { err: error, thread: thread.id },
            '[subagent] background run failed'
          );
        });
        const label = name ? `"${name}"` : 'it';
        return {
          background: true,
          note: `Subagent ${label} is running in the background and will post its own "kyto subagent" message when done. You won't get a report back — carry on with your other work now.`,
          success: true,
        };
      }
      return await job;
    },
  });
}
