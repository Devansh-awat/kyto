import {
  catalogAttempt,
  createAgent,
  LEADERBOARD_FALLBACK,
  openSession,
  type PiAttempt,
  ROUTER_MODEL,
  type SandboxContext,
  systemPrompt,
} from '@repo/ai';
import { loadSkills } from '@repo/sandbox';
import {
  type Message,
  type StreamChunk,
  StreamingPlan,
  type Thread,
} from 'chat';
import { deleteControls, type postControls } from '@/lib/agent/controls';
import { buildPrompt } from '@/lib/agent/prompt';
import { createReply } from '@/lib/agent/reply';
import { enterModelCapture } from '@/lib/agent/resolved-model';
import { sandbox } from '@/lib/agent/sandbox';
import {
  abortReasonOf,
  interruptTurn,
  queuedInput,
} from '@/lib/agent/steering';
import { clearTurn, getTurn, setTurn } from '@/lib/agent/turns';
import { startThinking } from '@/lib/agent/utils';
import { promptWithAttachments, seedAttachments } from '@/lib/ai/attachments';
import { requestHints } from '@/lib/ai/hints';
import { renderStream } from '@/lib/ai/stream';
import { buildTools } from '@/lib/ai/toolset';
import { runQueuedTurn } from '@/lib/ai/turn-queue';
import { bot, slack } from '@/lib/chat';
import { agentErrorMessage, BudgetExhaustedError } from '@/lib/errors';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';
import type { ActiveTurn, AgentErrorStage } from '@/types/agent';
import type { AttemptFailure } from '@/types/attempts';

// HackClub/OpenRouter daily-spend-limit rejection (also "insufficient credits").
// Matched against stream error parts to fail over off HackClub for the turn.
const SPEND_LIMIT_PATTERN = /spending limit|insufficient credits|daily limit/i;

// Hard ceiling on a single model attempt (the whole multi-step agentic stream).
// Without it, a stalled upstream SSE connection or a hung tool leaves the turn
// awaiting forever and the Slack "thinking" spinner never resolves — observed: a
// website-build turn froze indefinitely after streaming a "On it…" preamble and
// then issuing a browser open that never returned. On expiry we abort only THIS
// attempt's signal (not the shared turn controller), so the existing recovery
// path takes over: fall back to the next model if no reply text was streamed
// yet, or surface an error if it was. Override with AGENT_ATTEMPT_TIMEOUT_MS.
const ATTEMPT_TIMEOUT_MS =
  Number(process.env.AGENT_ATTEMPT_TIMEOUT_MS) || 10 * 60 * 1000;

class AttemptTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `Model attempt exceeded ${Math.round(ms / 1000)}s without completing.`
    );
    this.name = 'AttemptTimeoutError';
  }
}

export { stopAllTurns, stopTurn } from '@/lib/agent/turns';

export function runTurn(input: {
  message: Message;
  thread: Thread;
}): Promise<void> {
  const turn = getTurn({ threadId: input.thread.id });
  if (!turn) {
    return runQueuedTurn({
      threadId: input.thread.id,
      run: (controller) => executeTurn(input, controller),
    });
  }

  interruptTurn({ activeTurn: turn, input });
  return slack
    .addReaction(input.thread.id, input.message.id, 'white_check_mark')
    .catch(() => undefined);
}

async function executeTurn(
  { message, thread }: { message: Message; thread: Thread },
  controller: AbortController
): Promise<void> {
  const threadId = thread.id;
  logger.info({ text: message.text, threadId }, '[agent] turn started');
  const activeTurn: ActiveTurn = {
    controller,
    pendingMessages: [],
  };
  setTurn({ threadId, turn: activeTurn });
  await startThinking({ thread });
  const hints = await requestHints({ thread, message });

  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  let activeAttempt: PiAttempt | undefined;
  const controls: Awaited<ReturnType<typeof postControls>> = null;
  let sandboxContext: SandboxContext | undefined;
  let reply: ReturnType<typeof createReply> | undefined;
  let errorStage: AgentErrorStage = 'before_output';

  // No persistence: the Slack thread is the only memory, fed whole into each
  // turn. Tear the session down (kills the E2B sandbox iff it was materialized;
  // a chat-only turn never created one, so this is a cheap no-op there).
  const endSession = async (): Promise<void> => {
    if (!session) {
      return;
    }
    await session.destroy().catch(() => undefined);
  };

  try {
    // Slack's native streaming API (StreamingPlan -> adapter.stream) requires a
    // real threadTs. The patched @chat-adapter/slack (see patches/) now assigns
    // every message — DM or channel — a threadTs (falling back to the message's
    // own ts), so this should always be populated; kept as a defensive fallback
    // (mirrors the same check `startThinking` does) in case some other path
    // ever produces a threadId with no threadTs. Drains the turn generator
    // directly in that case — the reply text still goes out via
    // `reply.append`'s plain `thread.post`, we just skip the native task-card UI
    // that needs streaming.
    const { threadTs } = slack.decodeThreadId(thread.id);
    if (threadTs) {
      await thread.post(
        new StreamingPlan(renderTurn({ message, thread }), {
          groupTasks: 'plan',
        })
      );
    } else {
      for await (const _chunk of renderTurn({ message, thread })) {
        // Drained without posting task-card chunks; see comment above.
      }
    }
    if (!session) {
      throw new Error('Agent turn ended before session was recorded.');
    }
    await reply?.flush({ thread });
    if (hints.customization?.prompt && !slack.isDM(thread.id)) {
      await thread
        .post({
          markdown: "_kyto's responses are shaped by this user's instructions_",
        })
        .catch(() => undefined);
    }
    await deleteControls({ controls });
    await endSession();
    logger.info(
      { attempt: attemptLog(activeAttempt), threadId },
      '[agent] turn complete'
    );
  } catch (error) {
    const reason = abortReasonOf(controller.signal);
    if (reason) {
      logger.info({ reason, threadId }, '[agent] turn interrupted');
      await deleteControls({ controls });
      // No persistence: an interrupt re-runs immediately and the follow-up
      // rebuilds context from the whole Slack thread, so we always tear the
      // session down (and its sandbox, if any) regardless of the reason.
      await endSession();
    } else {
      logger.error(
        { attempt: attemptLog(activeAttempt), err: error, threadId },
        '[agent] turn failed'
      );
      await reply?.flush({ thread });
      await endSession();
      await deleteControls({ controls });
      await thread.post(agentErrorMessage({ error, stage: errorStage }));
    }
  } finally {
    clearTurn({ threadId, turn: activeTurn });
    // Only an interrupt replays queued messages; a rapid burst is merged into a
    // single follow-up so steering does not drop intermediate corrections.
    const resume =
      abortReasonOf(controller.signal) === 'interrupt'
        ? queuedInput(activeTurn)
        : undefined;
    if (resume) {
      runTurn(resume).catch((error: unknown) => {
        logger.error(
          { err: error, threadId },
          '[agent] failed to run interrupted follow-up turn'
        );
      });
    }
  }

  async function* renderTurn({
    message,
    thread,
  }: {
    message: Message;
    thread: Thread;
  }) {
    const skills = await loadSkills();
    const messageText = await buildPrompt(message, {
      customizationPrompt: hints.customization?.prompt,
      thread,
    });
    let attachments: Awaited<ReturnType<typeof seedAttachments>> = [];
    // Distinguish a turn that did real work from a truly empty completion. Only
    // a completion that produced NEITHER reply text, NOR a deliberate skip, NOR
    // any tool activity (e.g. an upstream 504 swallowed into an empty stream) is
    // treated as empty and falls through to another model. A turn that ran tools
    // did real work — restarting it on a fresh model would throw that away and
    // burn the fallback chain — so tool activity counts as a handled turn even if
    // the model never wrote a final summary.
    let producedText = false;
    let skipped = false;
    let producedToolActivity = false;
    // Tool results gathered so far this turn, deduped by tool+input. If a later
    // step truncates and the turn falls back to another model, these are replayed
    // into the fallback prompt so the new model answers from them instead of
    // re-running the same tools (e.g. identical web searches). Capped in
    // renderCarryover so the replay can't blow up context.
    const gatheredResults: GatheredResult[] = [];
    const gatheredKeys = new Set<string>();
    const attempts: AttemptFailure[] = [];
    // The main query runs on OpenRouter's own model router via HackClub
    // (`openrouter/auto`): OpenRouter picks the best underlying model per
    // request. On failure we (1) retry the exact model auto resolved to, then
    // (2) walk the leaderboard UP from that model (toward the best) and then
    // DOWN (toward the weakest) — see routeNextAttempt. Keeps the bot answering
    // and biases recovery toward stronger models when the chosen one fails.
    const failedKeys = new Set<string>();
    let triedAuto = false;
    let triedResolved = false;
    // The up-then-down leaderboard queue, built lazily once we know what
    // `openrouter/auto` resolved to (its rank is the pivot).
    let fallbackQueue: PiAttempt[] | undefined;
    // The per-turn model holder for the auto attempt; its `.model` is filled by
    // the fetch interceptor with the slug auto actually resolved to.
    let autoHolder: ReturnType<typeof enterModelCapture> | undefined;
    // Set when a HackClub call returns the daily-spend-limit 429. The limit is
    // enforced pessimistically (OpenRouter projects each request's worst-case
    // cost), so the dearer models get rejected first while budget remains — but
    // the capped `max_tokens` (resolved-model.ts) keeps the cheaper models'
    // projection low enough to still fit. So instead of skipping HackClub
    // entirely, this flips the fallback queue to try the HackClub rungs
    // CHEAPEST-first (most likely to pass) before failing over to the unmetered
    // baishui proxy (see buildFallbackQueue).
    let hackclubBudgetExhausted = false;
    // The raw daily-spend-limit 429 text (e.g. "Daily spending limit of $3
    // reached"), captured so a fully-failed turn can tell the user the budget is
    // spent (and name the cap) instead of showing a generic error.
    let spendLimitMessage: string | undefined;
    let attempt: PiAttempt | undefined;
    let geminiRetryCount = 0;
    // Built once: the tool set does not depend on the chosen model, and its keys
    // let renderStream hide hallucinated calls to non-existent tools.
    const tools = buildTools({
      bot,
      getSandboxContext: () => sandboxContext,
      message,
      thread,
    });
    const knownTools = new Set(Object.keys(tools));
    // Build the up-then-down leaderboard queue around the resolved model: climb
    // to better-ranked models first (closest-better → best), then descend to the
    // lower-ranked ones. If the resolved slug isn't on the leaderboard (or is
    // unknown), fall back to the full best→worst order.
    const buildFallbackQueue = (pivotModel?: string): PiAttempt[] => {
      // HackClub daily spend limit hit: the whole HackClub budget is shared, so
      // once the first call returns the spend-limit 429 EVERY other HackClub rung
      // 429s the same way (they just burn attempts at ~4ms each). Skip all of
      // them and go **straight to the owner's Gemini key** (separate quota,
      // reliable, cheap) — then any other non-HackClub rung (baishui, if
      // re-enabled). No more cheapest-first HackClub retries.
      if (hackclubBudgetExhausted) {
        const gemini = LEADERBOARD_FALLBACK.filter(
          (a) => a.provider === 'gemini'
        );
        const otherNonHackclub = LEADERBOARD_FALLBACK.filter(
          (a) => a.provider !== 'hackclub' && a.provider !== 'gemini'
        );
        return [...gemini, ...otherNonHackclub];
      }
      const idx = pivotModel
        ? LEADERBOARD_FALLBACK.findIndex((a) => a.model === pivotModel)
        : -1;
      if (idx === -1) {
        return [...LEADERBOARD_FALLBACK];
      }
      const up = LEADERBOARD_FALLBACK.slice(0, idx).reverse();
      const down = LEADERBOARD_FALLBACK.slice(idx + 1);
      return [...up, ...down];
    };
    // Selects the next attempt as a side effect: `openrouter/auto` first, then a
    // pinned retry of the model it resolved to, then the up-then-down queue
    // (each entry tried at most once, tracked via failedKeys).
    const routeNextAttempt = () => {
      if (!triedAuto) {
        triedAuto = true;
        attempt = catalogAttempt(ROUTER_MODEL);
        return;
      }
      const resolved = autoHolder?.model;
      if (!triedResolved) {
        triedResolved = true;
        fallbackQueue = buildFallbackQueue(resolved);
        // Retry the exact model auto resolved to (auto's failure may be
        // transient or an empty completion), if known and not already tried —
        // unless HackClub's budget is exhausted (the pinned retry is HackClub).
        if (
          !hackclubBudgetExhausted &&
          resolved &&
          !failedKeys.has(`hackclub:${resolved}`)
        ) {
          attempt = catalogAttempt(resolved);
          return;
        }
      }
      attempt = fallbackQueue?.find(
        (candidate) =>
          !failedKeys.has(`${candidate.provider}:${candidate.model}`)
      );
    };
    routeNextAttempt();
    logger.info(
      { model: attempt?.model, provider: attempt?.provider, threadId },
      '[agent] routed turn'
    );
    while (attempt) {
      const currentAttempt = attempt;
      // Per-attempt: did THIS attempt's stream finish deliberately (`stop`)?
      // Reset each attempt so a stale stop from a prior model can't mask a
      // truncated current one. A turn that ran tools but ended without a clean
      // stop (an empty/truncated synthesis step — the "stops mid-task" bug) never
      // delivered an answer, so it must fall back rather than end silently.
      let sawCleanStop = false;
      // Declared outside the try so the catch can complete the same task.
      const modelTaskId = `model-${attempts.length}`;
      // The model-lifecycle row reads as "Thinking" (the model is working) while
      // it runs, and completes to show which model actually answered. Tool rows
      // render separately, so a turn shows Thinking → tool activity → done.
      const modelTaskTitle =
        attempts.length > 0 ? 'Thinking · fallback' : 'Thinking';
      // Per-turn model holder for this attempt (filled with the slug auto/glm
      // resolved to). Declared outside the try so the catch can read it when it
      // completes the task. Guard so the Model task is completed EXACTLY once —
      // previously the post-stream complete AND the catch both fired when a
      // streamed attempt then failed the empty-check, rendering the model 2–3×.
      let modelHolder: ReturnType<typeof enterModelCapture> | undefined;
      let modelTaskDone = false;
      const completeModelTask = (): StreamChunk | undefined => {
        if (modelTaskDone) {
          return;
        }
        modelTaskDone = true;
        const resolved =
          modelHolder?.model && modelHolder.model !== currentAttempt.model
            ? ` → ${modelHolder.model}`
            : '';
        return {
          id: modelTaskId,
          output: `${currentAttempt.provider} · ${currentAttempt.model}${resolved}`,
          status: 'complete',
          title: modelTaskTitle,
          type: 'task_update',
        };
      };
      // Per-attempt watchdog: if this attempt stalls (a frozen upstream SSE
      // stream or a hung tool that never returns), abort just THIS attempt so
      // the catch below can recover instead of the turn hanging forever. Kept
      // separate from `controller` so a timeout is NOT mistaken for a user
      // interrupt (which tears the turn down silently); the combined signal
      // also reaches tool execution, so a hung sandbox command is killed too.
      const attemptAbort = new AbortController();
      const attemptTimer = setTimeout(() => {
        attemptAbort.abort(new AttemptTimeoutError(ATTEMPT_TIMEOUT_MS));
      }, ATTEMPT_TIMEOUT_MS);
      try {
        activeAttempt = currentAttempt;
        const agent = createAgent({
          attempt: currentAttempt,
          onSandboxReady: async (context) => {
            sandboxContext = context;
            // Only seeding attachments touches the sandbox here, and only when
            // the message actually has files — so a chat-only turn leaves the
            // lazy sandbox unmaterialized (zero E2B cost).
            attachments = await seedAttachments({
              message,
              sandboxContext: context,
            });
          },
          sandbox,
          sessionId: threadId,
          skills,
          systemPrompt: systemPrompt({ hints }),
          tools,
        });
        session = await openSession({ agent, threadId });
        reply = createReply({ threadId });
        // Surface the model in the thinking section (not the reply text).
        // Emitted `in_progress` while this attempt actually runs, so the
        // activity indicator reads as working (never a misleading "completed"
        // before anything has happened). It is marked `complete` after streaming
        // (below) on success, AND in the catch on failure, so it transitions to
        // done at the right moment and never sticks as a frozen spinner.
        // NO `output` while in progress: the completed emit (completeModelTask)
        // carries the model detail. Setting it on both states made the plan
        // render the provider·model line twice on the finished row.
        yield {
          id: modelTaskId,
          status: 'in_progress',
          title: modelTaskTitle,
          type: 'task_update',
        };
        // `openrouter/auto` resolves the real model server-side; capture it off
        // the global fetch so we can show the concrete pick (see resolved-model)
        // and pin it as the first fallback. Keep the holder ref for the auto
        // attempt so routeNextAttempt can read the resolved slug even on failure.
        modelHolder = enterModelCapture();
        if (currentAttempt.model === ROUTER_MODEL) {
          autoHolder = modelHolder;
        }
        const result = await agent.stream({
          abortSignal: AbortSignal.any([
            controller.signal,
            attemptAbort.signal,
          ]),
          prompt: promptWithAttachments({
            attachments,
            // On a fallback attempt, replay any tool results already gathered so
            // the new model continues from them instead of re-running the same
            // tools. First attempt (no prior failures) sends the plain prompt.
            text:
              attempts.length > 0 && gatheredResults.length > 0
                ? `${messageText}\n\n${renderCarryover(gatheredResults)}`
                : messageText,
          }),
          session,
        });
        for await (const chunk of renderStream({
          knownTools,
          onSkip: () => {
            // A skip is a deliberate, successful "no reply" — mark the turn as
            // handled so the empty-response guard below does NOT advance the
            // fallback chain (which previously produced placeholder garbage).
            skipped = true;
          },
          onTextDelta: async (text) => {
            producedText = true;
            errorStage = 'after_text';
            await reply?.append({ text, thread });
          },
          onToolActivity: () => {
            producedToolActivity = true;
          },
          onToolResult: (info) => {
            const key = `${info.toolName}:${stableInput(info.input)}`;
            if (gatheredKeys.has(key)) {
              return;
            }
            gatheredKeys.add(key);
            gatheredResults.push(info);
          },
          onFinish: (reason) => {
            // `stop` = the model deliberately ended its generation. Any other
            // reason (tool-calls/length) or no finish at all means the turn
            // didn't conclude on its own terms.
            if (reason === 'stop') {
              sawCleanStop = true;
            }
          },
          onError: (msg) => {
            // A HackClub daily-spend-limit 429 dooms every HackClub rung — flag
            // it so routeNextAttempt skips them and fails over to baishui.
            if (
              currentAttempt.provider === 'hackclub' &&
              SPEND_LIMIT_PATTERN.test(msg)
            ) {
              hackclubBudgetExhausted = true;
              spendLimitMessage = msg;
            }
          },
          stream: result.stream,
        })) {
          if (errorStage === 'before_output') {
            errorStage = 'after_progress';
          }
          yield chunk;
        }

        // Complete the Model task exactly once (the guard ensures the catch
        // won't re-complete it), appending the concrete model OpenRouter resolved
        // `openrouter/auto` to (now known from the streamed response).
        {
          const done = completeModelTask();
          if (done) {
            yield done;
          }
        }

        // Decide whether this completion delivered anything. Reply text or a
        // deliberate skip always counts. Tool activity counts as real work ONLY
        // if the stream also ended on a clean `stop` — i.e. the model ran tools
        // and then deliberately finished (it just didn't narrate). If it ran
        // tools but the stream ended WITHOUT a clean stop (an empty/truncated
        // synthesis step that emitted no text — the "stops mid-task" bug, e.g. a
        // spend-limit 429 or 504 swallowed into an empty continuation), the user
        // got no answer, so fall back to another model instead of returning
        // silently. A truly empty completion (no text, skip, or tools) also falls
        // back. This keeps the anti-cascade behavior (deliberate tool-then-stop
        // is handled) while never leaving a turn answerless mid-task.
        const handled =
          producedText || skipped || (producedToolActivity && sawCleanStop);
        if (!handled) {
          throw new Error(
            producedToolActivity
              ? `Model ${currentAttempt.model} ran tools but ended without a reply (truncated synthesis step).`
              : `Model ${currentAttempt.model} returned an empty response.`
          );
        }
        return;
      } catch (error) {
        const isGemini = currentAttempt.provider === 'gemini';
        const msg = errorMessage(error);
        const isRateLimit =
          (error &&
            typeof error === 'object' &&
            (('status' in error && error.status === 429) ||
              ('statusCode' in error && error.statusCode === 429))) ||
          /429|rate[-_\s]?limit|resource[-_\s]?exhausted|too[-_\s]?many[-_\s]?requests|quota[-_\s]?exceeded|rpm|tpm/i.test(
            msg
          );

        if (isGemini && isRateLimit && geminiRetryCount < 10) {
          geminiRetryCount++;
          logger.warn(
            {
              attempt: attemptLog(currentAttempt),
              err: msg,
              retryCount: geminiRetryCount,
              threadId,
            },
            '[agent] Gemini rate limit hit, waiting 30 seconds before retrying'
          );
          yield {
            id: modelTaskId,
            status: 'in_progress',
            title: `Thinking · Gemini rate limit (retrying in 30s) [${geminiRetryCount}/10]`,
            type: 'task_update',
          };
          await session?.detach().catch(() => undefined);
          session = undefined;
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          attempt = currentAttempt;
          continue;
        }

        // Mark this attempt's model task done so the activity indicator never
        // sticks on a frozen "Model · fallback" spinner when the attempt threw
        // before its post-stream completion yield ran. The guard makes this a
        // no-op if the post-stream completion already fired (so the model never
        // renders twice).
        {
          const done = completeModelTask();
          if (done) {
            yield done;
          }
        }
        attempts.push({ attempt: currentAttempt, error });
        failedKeys.add(`${currentAttempt.provider}:${currentAttempt.model}`);
        routeNextAttempt();
        const retryAttempt = attempt;
        // Gate on `producedText`, not `streamed`: if the model only emitted tool
        // activity (no reply text) before failing — including the empty-response
        // throw above — nothing user-visible was shown, so it is safe to fall
        // back to another model. Only a turn that already streamed real reply
        // text must not fall back (it would duplicate the user-facing output).
        if (controller.signal.aborted || producedText) {
          throw error;
        }
        if (!retryAttempt) {
          // Every model is exhausted. If the daily spend limit started the
          // cascade, surface that (the budget is the real cause) rather than the
          // last provider's generic error.
          if (hackclubBudgetExhausted) {
            throw new BudgetExhaustedError(spendLimitMessage, { cause: error });
          }
          throw error;
        }
        logger.warn(
          {
            attempt: attemptLog(currentAttempt),
            err: errorMessage(error),
            nextAttempt: attemptLog(retryAttempt),
            threadId,
          },
          '[agent] attempt failed, falling back'
        );
        await session?.detach().catch(() => undefined);
        session = undefined;
        attempt = retryAttempt;
      } finally {
        clearTimeout(attemptTimer);
      }
    }
  }
}

function attemptLog(attempt: PiAttempt | undefined) {
  return attempt
    ? { model: attempt.model, provider: attempt.provider }
    : undefined;
}

interface GatheredResult {
  input: unknown;
  output: unknown;
  toolName: string;
}

// Bounds on the replayed carryover so a fallback prompt can't blow up context
// (web-search results are large): keep the most recent results and clamp each.
const CARRYOVER_MAX_RESULTS = 12;
const CARRYOVER_OUTPUT_MAX = 1500;
const CARRYOVER_INPUT_MAX = 400;

function stableInput(input: unknown): string {
  try {
    return typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function toCompactText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : stableInput(value);
  return clamp(text, max) ?? text;
}

// Render gathered tool results as a prompt block the fallback model can answer
// from without re-running the tools. Most recent results win when over the cap.
function renderCarryover(results: GatheredResult[]): string {
  const recent = results.slice(-CARRYOVER_MAX_RESULTS);
  const lines = recent.map((result, index) => {
    const input = toCompactText(result.input, CARRYOVER_INPUT_MAX);
    const output = toCompactText(result.output, CARRYOVER_OUTPUT_MAX);
    return `${index + 1}. ${result.toolName}(${input})\n${output}`;
  });
  return [
    'A previous attempt already ran these tools and got these results. Use them to answer directly — do NOT re-run the same tools:',
    '',
    ...lines,
  ].join('\n');
}
