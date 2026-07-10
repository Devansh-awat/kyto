import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type SandboxContext,
  streamAttempt,
  subagentAttempt,
  subagentSystemPrompt,
} from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import type { KytoBot, Message, StreamChunk, ThreadHandle } from '@/harness';
import { requestHints } from '@/lib/ai/hints';
import { renderStream } from '@/lib/ai/stream';
import { slack } from '@/lib/chat';
import { resolveIdentity } from '@/lib/identity';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// A subagent is a headless copy of kyto: it shares the PARENT THREAD's sandbox
// (so it sees the files/state the parent set up, and vice versa), the same full
// toolset, pinned to a cheap model (Gemini flash-lite, else the best DigitalOcean
// BYOK model). It runs the same multi-step tool loop as a normal turn
// (streamAttempt drives it) and returns its final text as a report to the parent.
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

// The result a subagent run resolves to (also what a foreground call returns).
type SubagentResult =
  | { report: string; success: true }
  | { error: string; success: false };

// A background subagent, tracked in-turn so `checkSubagent` can collect it later
// (same lifetime model as the bash background-process trio: the handle map lives
// for this turn's tool closure only).
interface SubagentJob {
  id: string;
  name?: string;
  promise: Promise<SubagentResult>;
  result?: SubagentResult;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
}

export function runSubagentTool({
  bot,
  getSandboxContext,
  message,
  thread,
}: {
  bot: KytoBot;
  // The PARENT turn's sandbox context — the subagent runs in the SAME sandbox,
  // so it shares the parent's files/workspace rather than booting its own.
  getSandboxContext: () => SandboxContext;
  message: Message;
  thread: ThreadHandle;
}) {
  // Background subagents started this turn, keyed by id (sub-1, sub-2, …). Shared
  // between runSubagent (which registers) and checkSubagent (which collects).
  const jobs = new Map<string, SubagentJob>();
  let counter = 0;

  const runSubagent = tool({
    description:
      'Delegate a task to a subagent — a headless copy of kyto (shares your sandbox, same tools) that runs on a cheaper pinned model and posts its own "kyto subagent" message with its findings, then returns a written report to you. Use it for open-ended investigation or self-contained work that would otherwise clutter your own context. It has NO access to this conversation beyond what you put in the task. By default it runs FOREGROUND (you wait for its report, then use it). Set background:true to fire it off and keep working immediately — you get a job id back instead of the report, and later call checkSubagent with that id to collect its report (it also posts its own message).',
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
      // depthStore.run STARTS the job and returns its promise. Foreground
      // (default): await it and hand the report back to the parent model as this
      // tool call's RESULT — the next step sees the report and answers from it.
      // Background: don't await — the parent model gets control back this step and
      // keeps working while the subagent runs and posts its own message. It's
      // tied to the parent turn's abort signal (a user interrupt stops it).
      // Because the subagent shares the PARENT's sandbox, a foreground subagent is
      // always safe (the parent is paused mid-tool-call, still holding the sandbox
      // lock); a background one is best for quick side-tasks — if it runs long
      // after the parent turn ends, the sandbox is paused and its next sandbox
      // command transparently resumes it.
      const job: Promise<SubagentResult> = depthStore.run(
        depth + 1,
        async (): Promise<SubagentResult> => {
          // Share the PARENT turn's sandbox — the subagent works in the same
          // filesystem the parent set up (and leaves its own work there for the
          // parent to pick up). The parent owns this sandbox's lifecycle (it pauses
          // it at turn end), so the subagent must NOT create or destroy it.
          const sandboxContext = getSandboxContext();
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
                  finalReport ||
                    '(Completed actions with no additional message.)'
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
            // Only tear down the per-turn MCP/tool connections. The sandbox is the
            // parent's — the parent pauses it at turn end, so don't destroy it here.
            await close?.().catch(() => undefined);
          }
        }
      );

      if (background) {
        // Register the job so checkSubagent can collect it later, and keep its
        // status current as it resolves. Then hand control back to the parent.
        counter += 1;
        const id = `sub-${counter}`;
        const record: SubagentJob = {
          id,
          name,
          promise: job,
          startedAt: Date.now(),
          status: 'running',
        };
        jobs.set(id, record);
        job.then(
          (result) => {
            record.status = result.success ? 'done' : 'failed';
            record.result = result;
          },
          (error: unknown) => {
            record.status = 'failed';
            record.result = { error: errorMessage(error), success: false };
            logger.error(
              { err: error, thread: thread.id },
              '[subagent] background run failed'
            );
          }
        );
        const label = name ? `"${name}"` : 'it';
        return {
          background: true,
          id,
          note: `Subagent ${label} started in the background as ${id}. Keep working; when you need its findings call checkSubagent with id "${id}" (it also posts its own "kyto subagent" message).`,
          success: true,
        };
      }
      return await job;
    },
  });

  const checkSubagent = tool({
    description:
      "Check on background subagents you started with runSubagent (background:true). With no id, lists every background subagent this turn and its status. With an id, returns that subagent's status and — once finished — its full report. Set wait:true to block until it finishes before returning (use this to collect a background subagent's result before you answer).",
    inputSchema: z.object({
      id: z
        .string()
        .optional()
        .describe(
          'The background subagent id (e.g. "sub-1"). Omit to list all.'
        ),
      wait: z
        .boolean()
        .optional()
        .describe(
          'If true and the subagent is still running, block until it finishes, then return its report.'
        ),
    }),
    execute: async ({ id, wait }) => {
      if (!id) {
        return {
          jobs: [...jobs.values()].map((job) => ({
            id: job.id,
            name: job.name,
            running: job.status === 'running',
            status: job.status,
          })),
          success: true,
        };
      }
      const job = jobs.get(id);
      if (!job) {
        return {
          error: `Unknown background subagent id: ${id}`,
          success: false,
        };
      }
      if (wait && job.status === 'running') {
        // Bounded by the subagent's own run (and the turn's attempt watchdog): it
        // shares the turn abort signal, so a turn abort resolves this too.
        await job.promise.catch(() => undefined);
      }
      if (job.status === 'running') {
        return {
          id,
          running: true,
          status: 'running',
          summary: `Subagent ${id} is still running.`,
          success: true,
        };
      }
      return {
        error: job.result?.success === false ? job.result.error : undefined,
        id,
        report: job.result?.success ? job.result.report : undefined,
        running: false,
        status: job.status,
        success: job.status === 'done',
      };
    },
  });

  return { checkSubagent, runSubagent };
}
