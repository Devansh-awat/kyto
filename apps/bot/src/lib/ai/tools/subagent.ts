import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ModelAttempt,
  type SandboxContext,
  streamAttempt,
  subagentAttempts,
  subagentSystemPrompt,
} from '@repo/ai';
import type { ModelMessage, ToolSet } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import type { KytoBot } from '@/harness/bot';
import type { ThreadHandle } from '@/harness/thread';
import type { Message, StreamChunk } from '@/harness/types';
import { createCompactionReporter } from '@/lib/agent/compaction-card';
import { requestHints } from '@/lib/ai/hints';
import { renderStream } from '@/lib/ai/stream';
import { stripToolComplaints } from '@/lib/ai/stream/tool-complaints';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';

// A subagent is a headless copy of kyto: it shares the PARENT THREAD's sandbox
// (so it sees the files/state the parent set up, and vice versa), the same full
// toolset, pinned to a cheap model (the owner's Gemini key, else a HackClub
// rung — see subagentAttempts). It runs the same multi-step tool loop as a turn
// (streamAttempt drives it) and returns its final text as a report to the parent.
//
// Its work is surfaced as ITS OWN streamed plan message, posted under kyto's bot
// but NAMED for the subagent ("kyto subagent", or "kyto subagent {name}"), so the
// run reads as a distinct agent doing distinct work. EVERYTHING lives inside that
// one collapsible plan — a Prompt card (FULL task, unclamped), a Model card per
// attempt, the same interleaved thinking/tool cards a real turn shows (shared
// renderStream, in stream order), then a Response card holding its full report.
// NOTHING goes in the message body, so the subagent never speaks: its report goes
// to the parent model as the tool result, and the parent is the only voice.
//
// This run was briefly folded into the PARENT's plan block instead (a ChunkRelay,
// cards prefixed with the label), to stop the subagent's answer reading as kyto
// answering twice. Owner's call, 2026-07-30: the distinct card is what they want
// back — keeping the report out of the body is what stops the double voice, not
// merging the cards. The LABEL rule stays fixed (nothing configurable decorates
// it) and the subagent still has no icon of its own.
//
// Recursion is capped via AsyncLocalStorage. Only ONE level deep: a subagent may
// NOT spawn a further subagent (a runaway recursive spawn is a real cost/time
// risk with no natural backstop, and one level is all that's actually useful).
const MAX_SUBAGENT_DEPTH = 1;

const depthStore = new AsyncLocalStorage<number>();

// A BACKGROUND subagent almost always outlives the turn that started it — that
// is the point of backgrounding it. Without a wake, kyto would say "launched 5,
// I'll let you know", the turn would end, and kyto itself would never learn any
// of it happened. Nobody could ask it to
// act on what its own subagents found — and now that a subagent posts nothing of
// its own, the findings would reach nobody at all.
//
// So a finished background job WAKES the thread: it starts a fresh turn whose
// input is the report. kyto reads the findings and responds to them, the way a
// reminder firing does.
const WAKE_MESSAGE_PREFIX = 'subagent-report-';
// The wake must not abort the parent: runTurn's "a turn is already active" path
// interrupts the running one, which for a subagent finishing mid-turn would
// kill the very work that spawned it. Wait for the thread to go quiet instead.
const WAKE_POLL_MS = 4000;
const WAKE_MAX_WAIT_MS = 15 * 60 * 1000;

// The result a subagent run resolves to (also what a foreground call returns).
type SubagentResult =
  | { report: string; success: true }
  | { error: string; success: false };

// A subagent run, tracked so `subagent` (action `check`) can collect a
// background one later, and `resume` can ask any finished one a follow-up.
interface SubagentJob {
  /** Who started it: only they may resume it (its context may hold their data). */
  askerId: string;
  // Set once checkSubagent has handed this job's finished report back to the
  // model IN the live turn. wakeThread checks it right before posting, so a
  // report the model already collected and used isn't delivered a SECOND time as
  // a fresh "background subagent finished" turn (the job.then wake fires
  // independently of checkSubagent — nothing coordinated them before this flag).
  collected?: boolean;
  /** Its own run, kept once it finishes, for `resume`. */
  conversation?: ModelMessage[];
  /** When the latest run finished; the forget timer checks it's still that run. */
  finishedAt?: number;
  id: string;
  name?: string;
  promise?: Promise<SubagentResult>;
  result?: SubagentResult;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
}

// Per THREAD, not per turn. Any message in the thread mid-turn (a steer, an
// interrupt), a resume or the report's own wake runs a fresh runTurn with fresh
// tools, and a per-turn map made "sub-2" come back as an unknown id while the
// job was still running — its report was lost (issue #29). The counter is
// per-thread too, so a later turn's first job doesn't reuse "sub-1". In memory:
// a restart still loses them, as it does the jobs themselves.
const JOB_TTL_MS = 60 * 60 * 1000;
const threadJobs = new Map<
  string,
  { counter: number; jobs: Map<string, SubagentJob> }
>();

// A kept conversation's tool results are cut to this: a resume replays the
// whole run as its first request, and a run that read a few big files would
// otherwise start its follow-up past the long-context price step.
const KEPT_RESULT_CHARS = 4000;

/**
 * The run as it can be replayed: tool results cut to their heads, and the
 * reasoning dropped (a finished answer doesn't need it, and a provider can
 * refuse thinking it didn't sign).
 */
function resultText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

export function keepConversation(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.filter((part) => part.type !== 'reasoning'),
      };
    }
    if (message.role === 'tool') {
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === 'tool-result'
            ? {
                ...part,
                output: {
                  type: 'text' as const,
                  value:
                    clamp(
                      resultText(
                        'value' in part.output ? part.output.value : part.output
                      ),
                      KEPT_RESULT_CHARS
                    ) ?? '',
                },
              }
            : part
        ),
      };
    }
    return message;
  });
}

function forgetLater({
  finishedAt,
  id,
  threadId,
}: {
  finishedAt: number;
  id: string;
  threadId: string;
}) {
  setTimeout(() => {
    const registry = threadJobs.get(threadId);
    // Resumed since: its own, later timer forgets it.
    if (registry?.jobs.get(id)?.finishedAt !== finishedAt) {
      return;
    }
    registry.jobs.delete(id);
    if (registry?.jobs.size === 0) {
      threadJobs.delete(threadId);
    }
  }, JOB_TTL_MS).unref();
}

export function runSubagentTool({
  asUserAccount = false,
  bot,
  getSandboxContext,
  guardCodeTool,
  message,
  thread,
}: {
  bot: KytoBot;
  // The PARENT turn's sandbox context — the subagent runs in the SAME sandbox,
  // so it shares the parent's files/workspace rather than booting its own.
  getSandboxContext: () => SandboxContext;
  /** The parent turn's anti-coding check, so delegating does not dodge it. */
  guardCodeTool?: (call: {
    input: unknown;
    toolName: string;
  }) => Promise<string | null>;
  message: Message;
  thread: ThreadHandle;
  /** The parent answers as kyto's user account; so does the report's wake. */
  asUserAccount?: boolean;
}) {
  // Background subagents started in this thread, keyed by id (sub-1, sub-2, …).
  // Shared between runSubagent (which registers) and checkSubagent (which
  // collects). Looked up per call: the map may be dropped and recreated while
  // this turn's closure is alive.
  const registryFor = () => {
    let registry = threadJobs.get(thread.id);
    if (!registry) {
      registry = { counter: 0, jobs: new Map() };
      threadJobs.set(thread.id, registry);
    }
    return registry;
  };

  const runSubagent = tool({
    description:
      'Delegate a task to a subagent: a headless copy of kyto (shares your sandbox, same tools) that runs on a cheaper pinned model and returns a written report to you. Its run shows up inside your own plan/thinking block as it works; it does NOT post a message of its own, so YOU are the only voice in the thread and its findings only reach the user if you say them. Use it for open-ended investigation or self-contained work that would otherwise clutter your own context. It has NO access to this conversation beyond what you put in the task. By default it runs FOREGROUND (you wait for its report, then use it). Set background:true to fire it off and keep working immediately) you get a job id back instead of the report, and later call subagent (action check) with that id to collect it. Every run has an `id`: to follow up on what it found (dig deeper, fix what it found, a related question), pass that id as `resume` with the follow-up as `task`. It continues with its whole earlier run in context, which is cheaper and better informed than a fresh subagent.',
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
          'Optional short name for this subagent (e.g. "researcher"), used to label its cards in your plan as "kyto subagent {name}".'
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          'If true, spawn the subagent and return IMMEDIATELY without waiting: it runs independently and you get no report back on this call. Use it to run a side-task in parallel while you continue your own work; collect it later with subagent (action check), or let its report come back as a follow-up turn. Default false (wait for and receive the report).'
        ),
      resume: z
        .string()
        .optional()
        .describe(
          'The id of a FINISHED subagent (e.g. "sub-2") to continue: `task` becomes your follow-up to it, and it answers with everything from its earlier run still in its context (what it read, ran and found), instead of a fresh subagent starting over. For "dig deeper", "now fix what you found", "what about X". Ids last an hour after the run.'
        ),
    }),
    execute: async ({ task, name, background, resume }, { abortSignal }) => {
      if (subagentAttempts.length === 0) {
        return {
          error:
            'No subagent model is configured (the subagent roster is empty).',
          success: false,
        };
      }
      const depth = depthStore.getStore() ?? 0;
      if (depth >= MAX_SUBAGENT_DEPTH) {
        return {
          error: `Subagent nesting limit (${MAX_SUBAGENT_DEPTH}) reached: cannot delegate further.`,
          success: false,
        };
      }
      const registry = registryFor();
      let record: SubagentJob;
      if (resume) {
        const found = registry.jobs.get(resume);
        if (!found?.conversation) {
          return {
            error: found
              ? `Subagent ${resume} has nothing to resume: it is still running (collect it with subagent action check) or it failed before writing a report.`
              : `Unknown subagent id: ${resume}. Ids last an hour after a run finishes, in this thread, until kyto restarts. Start a new subagent instead.`,
            success: false,
          };
        }
        // Its context holds what it read on its asker's behalf.
        if (found.askerId !== message.author.userId) {
          return {
            error: `Subagent ${resume} was started for someone else, so it can't be resumed for this person. Start a new one.`,
            success: false,
          };
        }
        record = found;
        record.status = 'running';
        record.collected = false;
      } else {
        registry.counter += 1;
        record = {
          askerId: message.author.userId,
          id: `sub-${registry.counter}`,
          name,
          startedAt: Date.now(),
          status: 'running',
        };
      }
      const id = record.id;
      const label = record.name ?? name;
      const prior = record.conversation;
      record.conversation = undefined;
      // depthStore.run STARTS the job and returns its promise. Foreground
      // (default): await it and hand the report back to the parent model as this
      // tool call's RESULT — the next step sees the report and answers from it.
      // Background: don't await — the parent model gets control back this step and
      // keeps working while the subagent runs. It's tied to the parent turn's
      // abort signal (a user interrupt stops it).
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
          // The subagent's label: the display name on its own streamed message,
          // so its work is never mistaken for the main agent's. Fixed on
          // purpose (owner's call): the name is only ever "kyto",
          // "kyto subagent", or "kyto subagent {name}" — nothing configurable
          // decorates it, and there is no icon override.
          const cardLabel = label ? `kyto subagent ${label}` : 'kyto subagent';

          let close: (() => Promise<void>) | undefined;
          // The run that wrote the report, kept for a later `resume`.
          let conversation: ModelMessage[] | undefined;
          let ranTools = false;
          let report = '';
          // Text from an attempt that then THREW: kept only as a last resort, so
          // a half-written report isn't handed to the parent as a finished one
          // while a fallback model could still write the real thing.
          let cutOffReport = '';
          let lastError: unknown;

          try {
            const hints = await requestHints({ message, thread });
            const system = subagentSystemPrompt({ hints });
            const built = await buildTools({
              bot,
              getSandboxContext: () => sandboxContext,
              guardCodeTool,
              message,
              thread,
              // A subagent runs inside the parent's turn and has no watchdog of
              // its own to hold open, so an MCP tool set to ask permission refuses
              // here instead of stalling the parent behind a button.
              unattended: true,
            });
            close = built.close;
            const knownTools = new Set(Object.keys(built.tools));

            // The cards of the subagent's OWN plan message. Its ids live in that
            // message alone, so they need no namespacing — a concurrent subagent
            // (or the parent) is streaming into a different message entirely.
            const card = (
              id: string,
              title: string,
              status: 'complete' | 'error' | 'in_progress',
              output?: string
            ): StreamChunk => ({
              id,
              output: status === 'in_progress' ? '' : (output ?? ''),
              status,
              title,
              type: 'task_update',
            });

            // Yielded into the subagent's own `slack.stream`, so a card lands as
            // it happens rather than in one lump at the end.
            async function* subagentChunks(): AsyncGenerator<
              string | StreamChunk
            > {
              const promptTitle = prior ? 'Follow-up' : 'Prompt';
              yield card('prompt', promptTitle, 'in_progress');
              yield card('prompt', promptTitle, 'complete', task);
              // Walk the subagent roster. The cheap pinned tier returns an empty
              // completion often enough that a single model left a whole "herd"
              // of subagents reporting nothing back, so an attempt that produces
              // NO report (empty stream, or a thrown provider error) falls through
              // to the next model instead of failing the delegation.
              for (const [index, attempt] of subagentAttempts.entries()) {
                const modelTaskId = `model-${index}`;
                const modelTitle = index > 0 ? 'Model · fallback' : 'Model';
                yield card(modelTaskId, modelTitle, 'in_progress');
                try {
                  const compaction = createCompactionReporter({
                    context: { model: attempt.model, subagent: true },
                  });
                  const result = streamAttempt({
                    source: 'subagent',
                    onCompaction: compaction.onCompaction,
                    abortSignal,
                    activeTools: built.activeTools,
                    attempt,
                    getFreshImages: built.drainImages,
                    holder: {},
                    priorMessages: prior,
                    prompt: task,
                    // Background work, owner's call 2026-10-08: half price.
                    serviceTier: 'flex',
                    system,
                    tools: built.tools,
                  });
                  // No emitText: the subagent's prose is NOT streamed into the
                  // message body — it stays inside the collapsible plan (the
                  // Response card below) and goes to the parent model, which is
                  // the only voice in the thread.
                  yield* compaction.merge(
                    renderStream({
                      knownTools,
                      onTextDelta: (text) => {
                        report += text;
                      },
                      onToolActivity: () => {
                        ranTools = true;
                      },
                      stream: result.fullStream,
                    })
                  );
                  yield card(
                    modelTaskId,
                    modelTitle,
                    'complete',
                    attempt.model
                  );
                  if (report.trim()) {
                    const { messages } = await result.response;
                    conversation = keepConversation([
                      ...(prior ?? []),
                      { content: task, role: 'user' },
                      ...messages,
                    ]);
                  }
                } catch (error) {
                  lastError = error;
                  if (report.trim()) {
                    cutOffReport = report;
                  }
                  report = '';
                  yield card(
                    modelTaskId,
                    modelTitle,
                    'error',
                    errorMessage(error)
                  );
                }
                // A model that ran tools but wrote nothing leaves the parent with
                // "(Completed actions…)" — technically a success, useless as a
                // report. Ask THIS model to write it up. It keeps its real tools:
                // launching one with an empty toolset against a system prompt
                // describing them makes it narrate "no tools loaded" into the
                // report (owner's call 2026-08-22). The prompt is what tells it
                // not to act.
                if (!report.trim() && ranTools) {
                  report = await synthesizeReport({
                    abortSignal,
                    activeTools: built.activeTools,
                    attempt,
                    system,
                    task,
                    tools: built.tools,
                  }).catch(() => '');
                }
                if (report.trim()) {
                  break;
                }
                if (abortSignal?.aborted) {
                  break;
                }
              }
              const finalReport =
                report.trim() ||
                (cutOffReport.trim()
                  ? `${cutOffReport.trim()}\n\n(The subagent was cut off here; this report is incomplete.)`
                  : '');
              report = finalReport;
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

            // The subagent's own message: named for it, plan-mode, and nothing in
            // the body. Streamed live, so the cards fill in as it works.
            await slack.stream(thread.id, subagentChunks(), {
              recipientTeamId: slack.teamId ?? '',
              recipientUserId: message.author.userId,
              taskDisplayMode: 'plan',
              username: cardLabel,
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
              error: lastError
                ? `Subagent failed on every model. Last error: ${errorMessage(lastError)}`
                : 'Subagent produced an empty report.',
              success: false,
            };
          } catch (error) {
            return { error: errorMessage(error), success: false };
          } finally {
            // A failed resume keeps the run it was resuming.
            record.conversation = conversation ?? prior;
            // Only tear down the per-turn MCP/tool connections. The sandbox is the
            // parent's — the parent pauses it at turn end, so don't destroy it here.
            await close?.().catch(() => undefined);
          }
        }
      );

      // Every run is registered, foreground too, so it can be resumed.
      record.promise = job;
      record.result = undefined;
      registry.jobs.set(id, record);
      const settle = (result: SubagentResult) => {
        record.status = result.success ? 'done' : 'failed';
        record.result = result;
        record.finishedAt = Date.now();
        forgetLater({
          finishedAt: record.finishedAt,
          id,
          threadId: thread.id,
        });
      };
      const resumable = `To ask it a follow-up with its context intact, call subagent (action run) with resume: "${id}" and the follow-up as the task.`;
      if (!background) {
        const result = await job.catch(
          (error: unknown): SubagentResult => ({
            error: errorMessage(error),
            success: false,
          })
        );
        settle(result);
        return result.success
          ? { ...result, id, resume: resumable }
          : { ...result, id };
      }
      // A turn started BY a wake doesn't get to schedule another one, or five
      // subagents reporting back could each spawn a turn that spawns more.
      const mayWake = !message.id.startsWith(WAKE_MESSAGE_PREFIX);
      job.then(
        (result) => {
          settle(result);
          if (mayWake) {
            wakeThread({ asUserAccount, job: record, message, thread }).catch(
              () => undefined
            );
          }
        },
        (error: unknown) => {
          settle({ error: errorMessage(error), success: false });
          logger.error(
            { err: error, thread: thread.id },
            '[subagent] background run failed'
          );
          if (mayWake) {
            wakeThread({ asUserAccount, job: record, message, thread }).catch(
              () => undefined
            );
          }
        }
      );
      const jobLabel = label ? `"${label}"` : 'it';
      return {
        background: true,
        id,
        note: `Subagent ${jobLabel} started in the background as ${id}. Keep working; when you need its findings call subagent (action check) with id "${id}". If your turn ends before it finishes, that's fine: its report comes back to you as a new turn in this thread, so you don't have to wait for it. It does NOT post anything itself, so nothing reaches the user until you say it.`,
        success: true,
      };
    },
  });

  const checkSubagent = tool({
    description:
      "Check on subagents you started with runSubagent. With no id, lists every subagent in this thread (background or not) and its status. With an id, returns that subagent's status and (once finished) its full report. Set wait:true to block until it finishes before returning (use this to collect a background subagent's result before you answer).",
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
      const { jobs } = registryFor();
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
          error: `Unknown background subagent id: ${id}. Ids last until an hour after the job finishes or kyto restarts; a finished report also comes back as its own turn in this thread.`,
          success: false,
        };
      }
      if (wait && job.status === 'running') {
        // Bounded by the subagent's own run (and the turn's attempt watchdog): it
        // shares the turn abort signal, so a turn abort resolves this too.
        await job.promise?.catch(() => undefined);
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
      // The model is collecting this finished report in-turn, so it will use it
      // in its reply — don't also deliver it later as a background wake.
      job.collected = true;
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

/**
 * Hand a finished background subagent's report back to the thread as a new turn,
 * once the thread is quiet. Best effort throughout — a wake that fails must never
 * surface as an error mid-thread. Note the report IS lost to the user if this
 * fails, now that the subagent posts nothing itself: the journal line below is
 * the only trace, which is the right trade against derailing a live thread.
 */
async function wakeThread({
  asUserAccount,
  job,
  message,
  thread,
}: {
  asUserAccount: boolean;
  job: SubagentJob;
  message: Message;
  thread: ThreadHandle;
}): Promise<void> {
  try {
    const { getTurn, USER_ACCOUNT_TURN_SUFFIX } = await import(
      '@/lib/agent/turns'
    );
    const deadline = Date.now() + WAKE_MAX_WAIT_MS;
    const slot = asUserAccount
      ? `${thread.id}${USER_ACCOUNT_TURN_SUFFIX}`
      : thread.id;
    while (getTurn({ threadId: slot })) {
      if (Date.now() > deadline) {
        logger.warn(
          { id: job.id, threadId: thread.id },
          '[subagent] gave up waiting for the thread to go quiet'
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
    }
    // The thread went quiet — but if the model already collected this report via
    // checkSubagent during that turn, it's been used in the reply, so waking with
    // it again would post a duplicate. Re-check the claim right before acting
    // (not at attach time — checkSubagent usually runs while we're still polling).
    if (job.collected) {
      logger.info(
        { id: job.id, threadId: thread.id },
        '[subagent] report already collected in-turn; skipping background wake'
      );
      return;
    }
    const { runTurn } = await import('@/lib/agent');
    logger.info(
      { id: job.id, status: job.status, threadId: thread.id },
      '[subagent] waking the thread with a background report'
    );
    await runTurn({
      asUserAccount,
      message: reportMessage({ job, message, thread }),
      thread,
    });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), id: job.id, threadId: thread.id },
      '[subagent] failed to wake the thread'
    );
  }
}

/**
 * The synthetic message a wake turn runs on. Authored by whoever asked for the
 * subagent, so the turn is gated exactly as their own message would be — a
 * background job must not become a way to act with someone else's permissions.
 */
function reportMessage({
  job,
  message,
  thread,
}: {
  job: SubagentJob;
  message: Message;
  thread: ThreadHandle;
}): Message {
  const label = job.name ? `${job.id} ("${job.name}")` : job.id;
  const body =
    job.result?.success === true
      ? `It reported:\n\n${job.result.report}`
      : `It failed: ${job.result?.success === false ? job.result.error : 'unknown error'}`;
  return {
    attachments: [],
    author: message.author,
    id: `${WAKE_MESSAGE_PREFIX}${job.id}-${Date.now()}`,
    isMention: false,
    metadata: { dateSent: new Date() },
    raw: {},
    text: `[Automatic note, not written by a person: the background subagent ${label} you started earlier in this thread has finished. ${body}

Nobody in the thread has seen any of this: the subagent posts nothing of its own, so you are the only way these findings reach anyone. Reply with what actually matters from them for the task that was being worked on, in your own words and at whatever length it deserves. Don't thank anyone and don't explain that you were woken up. If the findings genuinely need nothing said, call the skip TOOL. Do not write the word "skip" as your reply.]`,
    threadId: thread.id,
  };
}

// A subagent that ran its tools and then stopped without writing anything gives
// the parent nothing to work with. Re-ask the SAME model, once, for the write-up.
//
// It keeps its REAL tools. An empty toolset here contradicted the system prompt
// sitting right above it, and weak models narrated that contradiction into the
// report ("no tools loaded"), which the parent then relayed to a person. Owner's
// call 2026-08-22: never launch a model without tools. Nothing here should need
// one — the work is done — so the prompt says so, and stripToolComplaints is the
// backstop for when a model says it anyway.
async function synthesizeReport({
  abortSignal,
  activeTools,
  attempt,
  system,
  task,
  tools,
}: {
  abortSignal?: AbortSignal;
  activeTools: () => string[];
  attempt: ModelAttempt;
  system: string[];
  task: string;
  tools: ToolSet;
}): Promise<string> {
  const result = streamAttempt({
    source: 'subagent',
    abortSignal,
    activeTools,
    attempt,
    holder: {},
    serviceTier: 'flex',
    prompt: `${task}\n\nYou already did the work above. Write your final report now: the findings, in full. This message is prose only: do not call anything, do not start new work, and do not describe your setup or environment.`,
    system,
    tools,
  });
  let text = '';
  for await (const delta of result.textStream) {
    text += delta;
  }
  // This report is what the parent turn reads and relays to a person, so a
  // sentence about tools being missing must never survive into it.
  return stripToolComplaints(text).trim();
}
