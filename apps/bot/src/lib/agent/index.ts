import {
  LEADERBOARD_FALLBACK,
  type ModelAttempt,
  PRIMARY_ATTEMPT,
  type ResolvedModelHolder,
  type SandboxContext,
  streamAttempt,
  systemPrompt,
} from '@repo/ai';
import { LazySandbox } from '@repo/sandbox';
import { env } from '@/env';
import type { Message, StreamChunk, ThreadHandle } from '@/harness';
import { buildPrompt } from '@/lib/agent/prompt';
import { createReply } from '@/lib/agent/reply';
import {
  abortReasonOf,
  interruptTurn,
  queuedInput,
} from '@/lib/agent/steering';
import { clearTurn, getTurn, setTurn } from '@/lib/agent/turns';
import { startThinking } from '@/lib/agent/utils';
import { promptWithAttachments, seedAttachments } from '@/lib/ai/attachments';
import { requestHints } from '@/lib/ai/hints';
import { renderStream, type StreamError } from '@/lib/ai/stream';
import { buildTools } from '@/lib/ai/toolset';
import { runQueuedTurn } from '@/lib/ai/turn-queue';
import { bot, slack } from '@/lib/chat';
import {
  agentErrorMessage,
  BudgetExhaustedError,
  StreamInterruptedError,
} from '@/lib/errors';
import logger from '@/lib/logger';
import { acquireThreadSandbox, threadSandboxStore } from '@/lib/sandbox/store';
import {
  registerProxyToken,
  revokeProxyToken,
  slackHelperInstall,
  slackProxyEnv,
} from '@/lib/slack-proxy';
import { deepErrorText, errorMessage, errorStatus } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';
import type { ActiveTurn, AgentErrorStage } from '@/types/agent';
import type { AttemptFailure } from '@/types/attempts';

// HackClub/OpenRouter daily-spend-limit rejection (also "insufficient credits").
// Matched against stream error parts to fail over off HackClub for the turn.
// HackClub's shared budget is exhausted. Matches both shapes it has returned:
// a 429 "Daily spending limit of $3 reached", and OpenRouter's own 403
// "Key limit exceeded (daily limit)". Both live in the response BODY, not the
// error message — see deepErrorText.
const SPEND_LIMIT_PATTERN =
  /spending limit|insufficient credits|daily limit|limit exceeded/i;

// How many non-budget HackClub failures in a turn before we treat HackClub as
// down and skip its remaining rungs. ONE is enough: every HackClub rung shares
// one proxy and one budget, so a rung that fails for a non-model reason (5xx,
// connection error, rate limit) means the next rung fails identically. Trying a
// second one only bought another "Thinking · fallback" card before the same
// verdict. The DigitalOcean BYOK tier is a genuinely separate quota, so jump.
const HACKCLUB_OUTAGE_THRESHOLD = 1;

// Hard ceiling on a single model attempt (the whole multi-step agentic stream).
// Without it, a stalled upstream SSE connection or a hung tool leaves the turn
// awaiting forever. On expiry we abort only THIS attempt's signal (not the
// shared turn controller), so the normal recovery path takes over: fall back to
// the next model if no reply text was streamed yet, or surface an error.
const ATTEMPT_TIMEOUT_MS =
  Number(process.env.AGENT_ATTEMPT_TIMEOUT_MS) || 10 * 60 * 1000;

// How much of a provider error body to keep in a log line: enough to name the
// real upstream cause (rate limit, context length, budget) without pasting a
// whole request body into the journal.
const ERROR_LOG_MAX_LENGTH = 800;

// How much already-sent reply text a continuation attempt is shown. Only the
// TAIL matters (the model needs to know where the thought was cut off), and the
// user's message plus carryover results are already in the prompt.
const STREAMED_TEXT_MAX = 4000;

function appendStreamedText(existing: string, text: string): string {
  const combined = existing + text;
  return combined.length > STREAMED_TEXT_MAX
    ? combined.slice(-STREAMED_TEXT_MAX)
    : combined;
}

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
  thread: ThreadHandle;
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
    .then(() => undefined)
    .catch(() => undefined);
}

async function executeTurn(
  { message, thread }: { message: Message; thread: ThreadHandle },
  controller: AbortController
): Promise<void> {
  const threadId = thread.id;
  // Only the owner may make kyto broadcast (@channel/@here/@everyone). For
  // everyone else those tokens are neutralized in the streamed reply and the
  // postMessage tool, so a non-owner can't get it to ping the whole channel.
  const isOwner =
    Boolean(env.OWNER_USER_ID) && message.author.userId === env.OWNER_USER_ID;
  const turnStart = Date.now();
  logger.info(
    {
      attachments: message.attachments.length,
      isOwner,
      text: message.text,
      threadId,
      userId: message.author.userId,
    },
    '[agent] turn started'
  );
  const activeTurn: ActiveTurn = {
    controller,
    pendingMessages: [],
  };
  setTurn({ threadId, turn: activeTurn });
  await startThinking({ thread });
  const hints = await requestHints({ thread, message });

  // Per-turn read-only Slack proxy secret: injected into the sandbox so a
  // script can query Slack (read-only) without the bot token, revoked at turn
  // end. Only when the sites server (which hosts the proxy) is enabled.
  const slackProxySecret = env.SITES_ENABLED ? registerProxyToken() : undefined;
  const proxyEnv = slackProxySecret
    ? slackProxyEnv(slackProxySecret, env.SITES_PUBLIC_HOST)
    : {};

  // The lazy sandbox: creating this object is free — the real E2B sandbox
  // materializes only when a tool first touches it. It is PER-THREAD and
  // PERSISTENT: destroy() pauses it rather than killing it, and the next turn in
  // this thread reconnects to the same filesystem, so files kyto wrote earlier
  // are still there. The store is what makes it persistent (see sandbox/store).
  const sandboxSession = new LazySandbox({
    apiKey: env.E2B_API_KEY,
    // Puts `slack <method>` on PATH, so the plain `bash` tool can query Slack
    // read-only too — not just the slackScript tool.
    bootstrapCommand: slackProxySecret ? slackHelperInstall() : undefined,
    env: proxyEnv,
    githubToken: env.GH_TOKEN,
    logger,
    sessionId: threadId,
    store: threadSandboxStore,
  });
  const sandboxContext: SandboxContext = {
    session: sandboxSession,
    sessionWorkDir: sandboxSession.workDir,
  };
  let closeTools: (() => Promise<void>) | undefined;
  let activeAttempt: ModelAttempt | undefined;
  // Every attempt that failed this turn, so the terminal log line explains the
  // whole fallback walk (which models were tried, and why each one died).
  const attempts: AttemptFailure[] = [];
  let reply: ReturnType<typeof createReply> | undefined;
  let errorStage: AgentErrorStage = 'before_output';
  // Filled by the successful attempt so the finalizer can render the usage
  // footer (output tokens · tokens/sec) if the user hasn't disabled it.
  let usageFooter:
    | { outputTokens: number; tokensPerSecond: number }
    | undefined;

  const cleanup = async (): Promise<void> => {
    revokeProxyToken(slackProxySecret);
    await closeTools?.().catch(() => undefined);
    await sandboxSession.destroy().catch(() => undefined);
  };

  // Hold this thread's sandbox for the whole turn, so a bash reminder firing on
  // the scheduler can't pause the sandbox out from under a running command.
  const releaseSandbox = await acquireThreadSandbox(threadId);

  try {
    // Slack's native streaming API renders the thinking/task-card UI. Every
    // message threads (a top-level message roots its own thread), so a valid
    // threadTs always exists. The turn is driven as a SEQUENCE of plan messages
    // (see streamSegmented) so that reply text splits the plan into separate
    // collapsible blocks: [plan] text [plan] text.
    await streamSegmented({ message, thread });
    await reply?.flush({ thread });
    if (hints.customization?.prompt && !slack.isDM(thread.id)) {
      await thread
        .post({
          markdown: "_kyto's responses are shaped by this user's instructions_",
        })
        .catch(() => undefined);
    }
    if (usageFooter && hints.customization?.showUsageFooter !== false) {
      await postUsageFooter({ footer: usageFooter, thread });
    }
    await cleanup();
    logger.info(
      {
        attempt: attemptLog(activeAttempt),
        durationMs: Date.now() - turnStart,
        failedAttempts: failedAttemptsLog(attempts),
        outputTokens: usageFooter?.outputTokens,
        threadId,
      },
      '[agent] turn complete'
    );
  } catch (error) {
    const reason = abortReasonOf(controller.signal);
    if (reason) {
      logger.info({ reason, threadId }, '[agent] turn interrupted');
      await cleanup();
    } else {
      logger.error(
        {
          attempt: attemptLog(activeAttempt),
          durationMs: Date.now() - turnStart,
          err: errorMessage(error),
          errorDetail: clamp(deepErrorText(error), ERROR_LOG_MAX_LENGTH),
          failedAttempts: failedAttemptsLog(attempts),
          stage: errorStage,
          status: errorStatus(error),
          threadId,
        },
        '[agent] turn failed'
      );
      await reply?.flush({ thread });
      await cleanup();
      await thread.post(agentErrorMessage({ error, stage: errorStage }));
    }
  } finally {
    // cleanup() (which pauses the sandbox) has already run on both paths above.
    releaseSandbox();
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
    message: turnMessage,
    thread: turnThread,
  }: {
    message: Message;
    thread: ThreadHandle;
  }): AsyncGenerator<string | StreamChunk> {
    const messageText = await buildPrompt(turnMessage, {
      customizationPrompt: hints.customization?.prompt,
      thread: turnThread,
    });
    // Seed attached files into the sandbox up front (materializes it only when
    // the message actually carries files — chat-only turns stay sandbox-free).
    const attachments =
      turnMessage.attachments.length > 0
        ? await seedAttachments({ message: turnMessage, sandboxContext })
        : [];
    // Distinguish a turn that did real work from a truly empty completion. Only
    // a completion that produced NEITHER reply text, NOR a deliberate skip, NOR
    // tool activity that ended on a clean `stop` is treated as unhandled and
    // falls through to another model (see the handled check below).
    let producedText = false;
    let skipped = false;
    // Everything the user has already been shown this turn. A fallback attempt
    // that CONTINUES an interrupted turn is told about it so it picks up instead
    // of repeating itself (renderContinuation).
    let streamedText = '';
    // Tool results gathered so far this turn, deduped by tool+input. If a later
    // step truncates and the turn falls back to another model, these are
    // replayed into the fallback prompt so the new model answers from them
    // instead of re-running the same tools.
    const gatheredResults: GatheredResult[] = [];
    const gatheredKeys = new Set<string>();
    // The main query runs on PRIMARY_ATTEMPT (a pinned model on the owner's
    // DigitalOcean BYOK quota). On failure we walk LEADERBOARD_FALLBACK from the
    // primary's rank UP (toward the best model) and then DOWN — see
    // routeNextAttempt. Models already tried are skipped via failedKeys.
    const failedKeys = new Set<string>();
    let triedPrimary = false;
    let fallbackQueue: ModelAttempt[] | undefined;
    // Set when a HackClub call returns the daily-spend-limit 429. The whole
    // HackClub budget is shared, so once one call 429s every HackClub rung
    // would too — the fallback queue then goes straight to the owner's Gemini
    // key (separate quota) instead of burning attempts.
    let hackclubBudgetExhausted = false;
    let spendLimitMessage: string | undefined;
    // Set when HackClub itself looks DOWN (repeated non-budget failures, e.g.
    // 5xx/connection errors), as opposed to just over budget. Every HackClub
    // rung would fail the same way, so once tripped we skip the rest of the
    // HackClub leaderboard and go straight to DigitalOcean/Gemini instead of
    // burning a dozen doomed attempts (the "lots of Thinking · fallback" bug).
    let hackclubFailures = 0;
    let hackclubUnavailable = false;
    let attempt: ModelAttempt | undefined;
    // Set per attempt (the watchdog is armed inside the loop below), but the
    // toolset is built ONCE up front — so the tools get a stable indirection
    // that always reaches the currently running attempt's watchdog.
    let extendDeadline: ((extraMs: number) => void) | undefined;
    // Built once: the toolset does not depend on the chosen model. Its keys let
    // renderStream hide hallucinated calls to non-existent tools; activeTools
    // drives deferred-tool visibility via prepareStep.
    const built = await buildTools({
      bot,
      extendAttemptDeadline: (extraMs) => extendDeadline?.(extraMs),
      getSandboxContext: () => sandboxContext,
      message: turnMessage,
      thread: turnThread,
    });
    closeTools = built.close;
    const knownTools = new Set(Object.keys(built.tools));

    const buildFallbackQueue = (pivotModel?: string): ModelAttempt[] => {
      if (hackclubBudgetExhausted || hackclubUnavailable) {
        const gemini = LEADERBOARD_FALLBACK.filter(
          (candidate) => candidate.provider === 'gemini'
        );
        // Non-HackClub, non-Gemini rungs = the DigitalOcean BYOK models. Try
        // them FIRST on a budget-exhaustion 429: they're a separate quota
        // (billed to DigitalOcean, not HackClub) and much stronger than the
        // cheap Gemini backstop, which stays last as the final safety net.
        const otherNonHackclub = LEADERBOARD_FALLBACK.filter(
          (candidate) =>
            candidate.provider !== 'hackclub' && candidate.provider !== 'gemini'
        );
        return [...otherNonHackclub, ...gemini];
      }
      const idx = pivotModel
        ? LEADERBOARD_FALLBACK.findIndex(
            (candidate) => candidate.model === pivotModel
          )
        : -1;
      if (idx === -1) {
        return [...LEADERBOARD_FALLBACK];
      }
      const up = LEADERBOARD_FALLBACK.slice(0, idx).reverse();
      const down = LEADERBOARD_FALLBACK.slice(idx + 1);
      return [...up, ...down];
    };
    const routeNextAttempt = () => {
      if (!triedPrimary) {
        triedPrimary = true;
        attempt = PRIMARY_ATTEMPT;
        return;
      }
      const skipHackclub = hackclubBudgetExhausted || hackclubUnavailable;
      fallbackQueue ??= buildFallbackQueue(PRIMARY_ATTEMPT.model);
      // If HackClub went down mid-walk, the queue built earlier may still list
      // its rungs; skip any HackClub candidate at selection time too so we don't
      // keep retrying a dead proxy.
      attempt = fallbackQueue.find(
        (candidate) =>
          !(
            failedKeys.has(`${candidate.provider}:${candidate.model}`) ||
            (skipHackclub && candidate.provider === 'hackclub')
          )
      );
    };
    routeNextAttempt();
    logger.info(
      { model: attempt?.model, provider: attempt?.provider, threadId },
      '[agent] routed turn'
    );
    // The prompt for the NEXT attempt: the user's message, plus (on a fallback)
    // the tool results already gathered, plus (when the turn was cut off after
    // it had started talking) what the user has already been shown.
    const attemptPrompt = (isFallback: boolean): string => {
      const blocks = [messageText];
      if (isFallback && gatheredResults.length > 0) {
        blocks.push(renderCarryover(gatheredResults));
      }
      if (isFallback && streamedText.trim().length > 0) {
        blocks.push(renderContinuation(streamedText));
      }
      return promptWithAttachments({
        attachments,
        text: blocks.join('\n\n'),
      });
    };

    while (attempt) {
      const currentAttempt = attempt;
      const modelTaskId = `model-${attempts.length}`;
      const modelTaskTitle =
        attempts.length > 0 ? 'Thinking · fallback' : 'Thinking';
      // Filled by streamAttempt's fetch with the resolved slug. The guard
      // completes the model task EXACTLY once (post-stream success or catch).
      const holder: ResolvedModelHolder = {};
      let modelTaskDone = false;
      const completeModelTask = (): StreamChunk | undefined => {
        if (modelTaskDone) {
          return;
        }
        modelTaskDone = true;
        // The model name is already shown as the in_progress `details` (below);
        // Slack keeps that line, so DON'T also send it as `output` here or the
        // card renders the model twice. Just mark the task complete.
        return {
          id: modelTaskId,
          status: 'complete',
          title: modelTaskTitle,
          type: 'task_update',
        };
      };
      // Per-attempt watchdog: if this attempt stalls, abort just THIS attempt
      // so the catch below can recover instead of the turn hanging forever.
      // Kept separate from `controller` so a timeout is NOT mistaken for a
      // user interrupt. The combined signal also reaches tool execution.
      // Re-armable: the `wait` tool pushes the deadline out for the length of a
      // deliberate pause (up to an hour), so a long wait isn't read as a stall.
      const attemptAbort = new AbortController();
      let attemptTimer: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = (ms: number) => {
        clearTimeout(attemptTimer);
        attemptTimer = setTimeout(() => {
          attemptAbort.abort(new AttemptTimeoutError(ms));
        }, ms);
      };
      armWatchdog(ATTEMPT_TIMEOUT_MS);
      // Grant the full idle budget on TOP of the pause, so the model still has
      // its normal working window once the wait is over.
      extendDeadline = (extraMs) => armWatchdog(ATTEMPT_TIMEOUT_MS + extraMs);
      // Per-ATTEMPT outcome (the turn-level flags above persist across attempts).
      // A continuation attempt inherits `producedText` from the interrupted one,
      // so "did THIS model answer?" has to be tracked separately or the fallback
      // would count its predecessor's text as its own and return silently.
      let attemptText = false;
      let attemptToolActivity = false;
      let attemptFinishReason: string | undefined;
      let attemptStreamError: StreamError | undefined;
      const isFallback = attempts.length > 0;
      try {
        activeAttempt = currentAttempt;
        reply ??= createReply({ allowBroadcast: isOwner, threadId });
        logger.info(
          {
            attempt: attemptLog(currentAttempt),
            continuing: isFallback && streamedText.length > 0,
            index: attempts.length,
            threadId,
          },
          '[agent] attempt started'
        );
        // Surface the model in the thinking section: `in_progress` while this
        // attempt runs (showing the model it's about to run), completed exactly
        // once with the slug it actually resolved to. Yielded once in_progress
        // and once complete, so `details` never stacks.
        yield {
          details: currentAttempt.model,
          id: modelTaskId,
          status: 'in_progress',
          title: modelTaskTitle,
          type: 'task_update',
        };
        const attemptStart = Date.now();
        const result = streamAttempt({
          abortSignal: AbortSignal.any([
            controller.signal,
            attemptAbort.signal,
          ]),
          activeTools: built.activeTools,
          attempt: currentAttempt,
          holder,
          // Errors the SDK swallows into the stream would otherwise be dumped
          // raw to stderr by its default console.error handler, unattributed.
          onError: (error) => {
            logger.error(
              {
                attempt: attemptLog(currentAttempt),
                err: errorMessage(error),
                status: errorStatus(error),
                threadId,
              },
              '[agent] provider error inside attempt stream'
            );
          },
          prompt: attemptPrompt(isFallback),
          system: systemPrompt({ hints }),
          tools: built.tools,
        });
        for await (const chunk of renderStream({
          context: {
            ...attemptLog(currentAttempt),
            threadId,
          },
          // Reply text is yielded as strings (the message body) so streamSegmented
          // can split the plan on text→tool boundaries; onTextDelta only tracks
          // flags now — the actual posting happens in streamSegmented.
          emitText: true,
          knownTools,
          onSkip: () => {
            // A skip is a deliberate, successful "no reply".
            skipped = true;
          },
          onTextDelta: (text) => {
            producedText = true;
            attemptText = true;
            errorStage = 'after_text';
            streamedText = appendStreamedText(streamedText, text);
          },
          onToolActivity: () => {
            attemptToolActivity = true;
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
            attemptFinishReason = reason;
          },
          onError: (info) => {
            attemptStreamError ??= info;
            // A HackClub daily-spend-limit 429 dooms every HackClub rung.
            if (
              currentAttempt.provider === 'hackclub' &&
              SPEND_LIMIT_PATTERN.test(info.message)
            ) {
              hackclubBudgetExhausted = true;
              spendLimitMessage = info.message;
            }
          },
          stream: result.fullStream,
        })) {
          if (typeof chunk === 'string') {
            // First VISIBLE reply text of this attempt: complete its Thinking
            // card NOW, in the current plan block, before streamSegmented splits
            // off a new block for any tools that run after the text. Otherwise
            // the model card would try to complete in a later block where its id
            // doesn't exist and the plan would show a perpetually spinning
            // Thinking. Whitespace-only fragments don't count (see isVisibleText).
            if (isVisibleText(chunk)) {
              const done = completeModelTask();
              if (done) {
                yield done;
              }
            }
          } else if (errorStage === 'before_output') {
            errorStage = 'after_progress';
          }
          yield chunk;
        }

        {
          const done = completeModelTask();
          if (done) {
            yield done;
          }
        }

        // The provider died PART WAY THROUGH this attempt. The SDK does not
        // throw for that: a step whose request fails (429, 5xx, dropped
        // connection) after its internal retries becomes an `error` part and the
        // stream just ends. If the model was still mid-task — it never finished
        // on a clean `stop` — then whatever it had already said is a half-finished
        // thought, and the old code called the turn "handled" and went quiet:
        // exactly the "kyto stopped in the middle" report. Raise it so the
        // fallback chain CONTINUES the turn on the next model.
        if (attemptStreamError && attemptFinishReason !== 'stop') {
          throw new StreamInterruptedError(
            `Model ${currentAttempt.model} died mid-task (${attemptStreamError.status ?? 'stream error'}): ${attemptStreamError.message}`,
            { cause: attemptStreamError.error }
          );
        }

        // A model that ran tools and then ended WITHOUT writing a reply leaves
        // the user staring at tool cards and nothing else — the other half of the
        // "stops in the middle" bug. Treating it as handled means silence;
        // treating it as a failure re-runs the whole turn on another model and
        // could repeat a side effect. So ask THIS model, once, to write up what
        // it already found — tools are off, so it can only produce prose, and
        // nothing can happen twice.
        //
        // This fires on ANY finish reason, not just a clean `stop`. The turns
        // that actually went silent ended on `length` (the reply was cut off
        // mid-tool-call by MAX_OUTPUT_TOKENS) or `tool-calls` (the MAX_STEPS cap
        // hit with a call still pending) — exactly the cases the old
        // `sawCleanStop` guard excluded, so they fell through to a fallback
        // cascade that re-ran the work and often died with no reply at all.
        if (!(attemptText || skipped) && attemptToolActivity) {
          yield* synthesizeFinalAnswer({
            attempt: currentAttempt,
            onText: (text) => {
              producedText = true;
              attemptText = true;
              errorStage = 'after_text';
              streamedText = appendStreamedText(streamedText, text);
            },
            results: gatheredResults,
            signal: AbortSignal.any([controller.signal, attemptAbort.signal]),
            system: systemPrompt({ hints }),
            task: messageText,
          });
        }

        // Reply text from THIS attempt, or a deliberate skip, counts as handled.
        // (Not the turn-level `producedText`: a continuation attempt inherits it
        // from the interrupted attempt, and would otherwise report success while
        // contributing nothing.) Anything else — including tool activity whose
        // synthesis nudge above came back empty — falls back to another model,
        // which replays the gathered tool results via renderCarryover rather than
        // re-running them.
        const handled = attemptText || skipped;
        if (!handled) {
          throw new Error(
            attemptToolActivity
              ? `Model ${currentAttempt.model} ran tools but ended without a reply (truncated synthesis step).`
              : `Model ${currentAttempt.model} returned an empty response.`
          );
        }
        logger.info(
          {
            attempt: attemptLog(currentAttempt),
            durationMs: Date.now() - attemptStart,
            outcome: skipped ? 'skip' : 'text',
            steps: holder.calls,
            threadId,
          },
          '[agent] attempt handled the turn'
        );
        // Capture usage for the footer (best-effort; never fails the turn).
        if (attemptText) {
          const usage = await Promise.resolve(result.usage).catch(
            () => undefined
          );
          const outputTokens = usage?.outputTokens ?? usage?.totalTokens;
          const elapsedSeconds = (Date.now() - attemptStart) / 1000;
          if (outputTokens && elapsedSeconds > 0) {
            usageFooter = {
              outputTokens,
              tokensPerSecond: outputTokens / elapsedSeconds,
            };
          }
        }
        return;
      } catch (error) {
        {
          const done = completeModelTask();
          if (done) {
            yield done;
          }
        }
        attempts.push({ attempt: currentAttempt, error });
        failedKeys.add(`${currentAttempt.provider}:${currentAttempt.model}`);
        // Also catch a spend-limit 429 that surfaced as a THROWN error (not a
        // stream error part) — same effect as onError: skip the rest of the
        // HackClub rungs and go straight to DigitalOcean/Gemini.
        if (currentAttempt.provider === 'hackclub') {
          if (SPEND_LIMIT_PATTERN.test(thrownErrorText(error))) {
            hackclubBudgetExhausted = true;
            spendLimitMessage ??= thrownErrorText(error);
          } else {
            // A non-budget HackClub failure. Enough of these means the proxy is
            // down, not just this one model, so bail off HackClub entirely.
            hackclubFailures += 1;
            if (hackclubFailures >= HACKCLUB_OUTAGE_THRESHOLD) {
              hackclubUnavailable = true;
            }
          }
        }
        routeNextAttempt();
        const retryAttempt = attempt;
        // A turn that already streamed reply text normally must NOT fall back —
        // the next model would restate the answer and the user would read it
        // twice. The one exception is a provider that died mid-task: kyto has
        // been cut off mid-sentence, so silence is the worse outcome. The next
        // model is told what was already sent (renderContinuation) and picks the
        // work back up instead of starting over.
        const canContinue = error instanceof StreamInterruptedError;
        if (controller.signal.aborted || (producedText && !canContinue)) {
          throw error;
        }
        if (!retryAttempt) {
          if (hackclubBudgetExhausted) {
            throw new BudgetExhaustedError(spendLimitMessage, { cause: error });
          }
          throw error;
        }
        logger.warn(
          {
            attempt: attemptLog(currentAttempt),
            continuing: canContinue && producedText,
            err: errorMessage(error),
            errorDetail: clamp(deepErrorText(error), ERROR_LOG_MAX_LENGTH),
            nextAttempt: attemptLog(retryAttempt),
            status: errorStatus(error),
            threadId,
          },
          '[agent] attempt failed, falling back'
        );
        attempt = retryAttempt;
      } finally {
        clearTimeout(attemptTimer);
      }
    }
  }

  // Drive the turn as a SEQUENCE of streamed plan messages instead of one. A
  // "segment" is one collapsible plan block (its task cards) followed by any
  // reply text; the FIRST task card that arrives AFTER text has streamed opens a
  // NEW plan block below that text. So a turn that writes some text, runs more
  // tools, then writes more renders as [plan] text [plan] text — the model can
  // post an in-between update and keep working in a fresh block, instead of
  // every tool of the whole turn piling into one plan pinned above all the text.
  async function streamSegmented({
    message: turnMessage,
    thread: turnThread,
  }: {
    message: Message;
    thread: ThreadHandle;
  }): Promise<void> {
    const source = renderTurn({
      message: turnMessage,
      thread: turnThread,
    })[Symbol.asyncIterator]();
    let pending = await source.next();
    while (!pending.done) {
      // Reply text before any plan block of this segment (a pure-text turn, or
      // text trailing the previous block) is just posted — no empty plan.
      if (typeof pending.value === 'string') {
        await reply?.append({ text: pending.value, thread: turnThread });
        pending = await source.next();
        continue;
      }
      let sawText = false;
      // One plan block: task cards until reply text streams, then the next task
      // card ends this block (left on `pending` for the next iteration).
      const segment = async function* (): AsyncGenerator<StreamChunk> {
        while (!pending.done) {
          const value = pending.value;
          if (typeof value === 'string') {
            // Only text the user will actually SEE ends this block. Models
            // routinely emit whitespace-only fragments ("\n") between tool
            // calls; those never reach Slack (createReply drops them), so
            // splitting on them opened a new empty collapsible block for every
            // stretch of tools — the "three plan blocks, no text in between"
            // bug. A block now splits only after real prose has been written.
            sawText ||= isVisibleText(value);
            await reply?.append({ text: value, thread: turnThread });
            pending = await source.next();
            continue;
          }
          if (sawText) {
            return;
          }
          yield value;
          pending = await source.next();
        }
      };
      await slack.stream(threadId, segment(), {
        recipientTeamId: slack.teamId ?? '',
        recipientUserId: turnMessage.author.userId,
        taskDisplayMode: 'plan',
      });
      // Post any buffered text before the next plan block is created, so the
      // ordering (plan → text → plan) holds.
      await reply?.flush({ thread: turnThread });
    }
  }
}

// Does this text fragment produce anything the user will actually see? Reply
// text is buffered by createReply and posted on blank-line boundaries, and a
// whitespace-only buffer is never posted at all — so a whitespace fragment must
// not be treated as "the model has replied" for plan-block or model-card
// purposes.
function isVisibleText(text: string): boolean {
  return text.trim().length > 0;
}

// Fold an error's message + provider responseBody/data into one string so the
// spend-limit pattern can match text (e.g. "Daily spending limit of $3 reached")
// that lives in responseBody rather than the error message.
const thrownErrorText = deepErrorText;

function attemptLog(attempt: ModelAttempt | undefined) {
  return attempt
    ? { model: attempt.model, provider: attempt.provider }
    : undefined;
}

// The whole fallback walk on one line: which models were tried, and the real
// upstream reason each one died. This is what turns "kyto went quiet" into a
// diagnosable event without reading the Slack thread.
function failedAttemptsLog(attempts: AttemptFailure[]) {
  return attempts.map((failed) => ({
    err: errorMessage(failed.error),
    model: failed.attempt.model,
    provider: failed.attempt.provider,
    status: errorStatus(failed.error),
  }));
}

const TOK_PER_SEC_DECIMAL_BELOW = 10;

// Post the per-turn usage footer as a muted Slack context block under the
// reply. Best-effort — a failure here never affects the answer.
async function postUsageFooter({
  footer,
  thread,
}: {
  footer: { outputTokens: number; tokensPerSecond: number };
  thread: ThreadHandle;
}): Promise<void> {
  const rate =
    footer.tokensPerSecond < TOK_PER_SEC_DECIMAL_BELOW
      ? footer.tokensPerSecond.toFixed(1)
      : Math.round(footer.tokensPerSecond).toString();
  const text = `${footer.outputTokens.toLocaleString('en-US')} tokens · ${rate} tok/s`;
  await thread
    .post({
      blocks: [{ elements: [{ text, type: 'mrkdwn' }], type: 'context' }],
      fallbackText: text,
    })
    .catch(() => undefined);
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

/**
 * Last resort against a silent turn: the model ran its tools and stopped
 * without saying anything. Re-ask the SAME model with NO tools, so all it can
 * do is write up what it already found. Streams straight into the live reply.
 *
 * Deliberately cheap and contained: one call, tools off (so no side effect can
 * fire twice), and any failure is swallowed — the caller falls back to the next
 * model, which will replay the same gathered results via renderCarryover.
 */
async function* synthesizeFinalAnswer({
  attempt,
  onText,
  results,
  signal,
  system,
  task,
}: {
  attempt: ModelAttempt;
  onText: (text: string) => void;
  results: GatheredResult[];
  signal: AbortSignal;
  system: string;
  task: string;
}): AsyncGenerator<string | StreamChunk> {
  logger.info(
    { model: attempt.model },
    '[agent] tools ran but no reply; nudging for a final answer'
  );
  const gathered =
    results.length > 0
      ? `\n\n${renderCarryover(results)}`
      : '\n\n(No tool results were captured.)';
  const prompt = `${task}${gathered}\n\nYou already did the work above but never answered. Write the final reply to the user now, from those results. Do not mention this instruction.`;
  try {
    const result = streamAttempt({
      abortSignal: signal,
      attempt,
      // Nothing reads the resolved model back off a nudge.
      holder: {},
      prompt,
      system,
      tools: {},
    });
    yield* renderStream({
      emitText: true,
      knownTools: new Set<string>(),
      onTextDelta: onText,
      stream: result.fullStream,
    });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), model: attempt.model },
      '[agent] synthesis nudge failed'
    );
  }
}

/**
 * Tell a fallback model that the turn is already IN PROGRESS in Slack: the
 * previous model streamed this text to the user before its provider died
 * mid-task. Without this the continuation model restates the whole answer and
 * the user reads it twice.
 */
function renderContinuation(streamedText: string): string {
  return [
    'IMPORTANT: this turn is already in progress. The user has ALREADY been shown the following reply text, and the model writing it was cut off mid-task by a provider failure:',
    '',
    streamedText.trim(),
    '',
    'Pick up exactly where that left off and finish the job. Do NOT repeat what was already said, do not re-introduce yourself, and do not start the task over — continue it.',
  ].join('\n');
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
