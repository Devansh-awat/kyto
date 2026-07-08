import {
  catalogAttempt,
  LEADERBOARD_FALLBACK,
  type ModelAttempt,
  type ResolvedModelHolder,
  ROUTER_MODEL,
  type SandboxContext,
  streamAttempt,
  systemPrompt,
} from '@repo/ai';
import { LazySandbox } from '@repo/sandbox';
import { env } from '@/env';
import type { Message, StreamChunk, ThreadHandle } from '@/harness';
import { buildPrompt } from '@/lib/agent/prompt';
import { createReply } from '@/lib/agent/reply';
import { ChunkChannel, mergeStream } from '@/lib/agent/side-channel';
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
import { registerProxyToken, revokeProxyToken } from '@/lib/slack-proxy';
import { errorMessage } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';
import type { ActiveTurn, AgentErrorStage } from '@/types/agent';
import type { AttemptFailure } from '@/types/attempts';

// HackClub/OpenRouter daily-spend-limit rejection (also "insufficient credits").
// Matched against stream error parts to fail over off HackClub for the turn.
const SPEND_LIMIT_PATTERN = /spending limit|insufficient credits|daily limit/i;

// Hard ceiling on a single model attempt (the whole multi-step agentic stream).
// Without it, a stalled upstream SSE connection or a hung tool leaves the turn
// awaiting forever. On expiry we abort only THIS attempt's signal (not the
// shared turn controller), so the normal recovery path takes over: fall back to
// the next model if no reply text was streamed yet, or surface an error.
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
  logger.info({ text: message.text, threadId }, '[agent] turn started');
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
  const slackProxyEnv: Record<string, string> = slackProxySecret
    ? {
        KYTO_SLACK_PROXY: `https://${env.SITES_PUBLIC_HOST}/_slackapi`,
        KYTO_SLACK_PROXY_TOKEN: slackProxySecret,
      }
    : {};

  // The lazy sandbox: creating this object is free — the real E2B sandbox
  // materializes only when a tool first touches it, and destroy() at turn end
  // kills it iff it materialized. Nothing persists between turns.
  const sandboxSession = new LazySandbox({
    apiKey: env.E2B_API_KEY,
    env: slackProxyEnv,
    githubToken: env.GH_TOKEN,
    logger,
    sessionId: threadId,
  });
  const sandboxContext: SandboxContext = {
    session: sandboxSession,
    sessionWorkDir: sandboxSession.workDir,
  };
  let closeTools: (() => Promise<void>) | undefined;
  let activeAttempt: ModelAttempt | undefined;
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

  try {
    // Slack's native streaming API renders the thinking/task-card UI. Every
    // message threads (a top-level message roots its own thread), so a valid
    // threadTs always exists.
    await slack.stream(threadId, renderTurn({ message, thread }), {
      recipientTeamId: slack.teamId ?? '',
      recipientUserId: message.author.userId,
      taskDisplayMode: 'plan',
    });
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
      { attempt: attemptLog(activeAttempt), threadId },
      '[agent] turn complete'
    );
  } catch (error) {
    const reason = abortReasonOf(controller.signal);
    if (reason) {
      logger.info({ reason, threadId }, '[agent] turn interrupted');
      await cleanup();
    } else {
      logger.error(
        { attempt: attemptLog(activeAttempt), err: error, threadId },
        '[agent] turn failed'
      );
      await reply?.flush({ thread });
      await cleanup();
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
    let producedToolActivity = false;
    // Tool results gathered so far this turn, deduped by tool+input. If a later
    // step truncates and the turn falls back to another model, these are
    // replayed into the fallback prompt so the new model answers from them
    // instead of re-running the same tools.
    const gatheredResults: GatheredResult[] = [];
    const gatheredKeys = new Set<string>();
    const attempts: AttemptFailure[] = [];
    // The main query runs on OpenRouter's own model router via HackClub
    // (`openrouter/auto`). On failure we (1) retry the exact model auto
    // resolved to, then (2) walk the leaderboard UP from that model (toward
    // the best) and then DOWN — see routeNextAttempt.
    const failedKeys = new Set<string>();
    let triedAuto = false;
    let triedResolved = false;
    let fallbackQueue: ModelAttempt[] | undefined;
    // The auto attempt's holder; `.model` is filled with the slug auto
    // actually resolved to (read off the response by streamAttempt's fetch).
    let autoHolder: ResolvedModelHolder | undefined;
    // Set when a HackClub call returns the daily-spend-limit 429. The whole
    // HackClub budget is shared, so once one call 429s every HackClub rung
    // would too — the fallback queue then goes straight to the owner's Gemini
    // key (separate quota) instead of burning attempts.
    let hackclubBudgetExhausted = false;
    let spendLimitMessage: string | undefined;
    let attempt: ModelAttempt | undefined;
    // Lets tools (the subagent) push their own live task cards into the plan.
    // Rebound to the current attempt's channel each attempt; a no-op otherwise.
    let emitToPlan: ((chunk: StreamChunk) => void) | undefined;
    // Built once: the toolset does not depend on the chosen model. Its keys let
    // renderStream hide hallucinated calls to non-existent tools; activeTools
    // drives deferred-tool visibility via prepareStep.
    const built = await buildTools({
      bot,
      emitChunk: (chunk: StreamChunk) => emitToPlan?.(chunk),
      getSandboxContext: () => sandboxContext,
      message: turnMessage,
      thread: turnThread,
    });
    closeTools = built.close;
    const knownTools = new Set(Object.keys(built.tools));

    const buildFallbackQueue = (pivotModel?: string): ModelAttempt[] => {
      if (hackclubBudgetExhausted) {
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
        // transient), unless HackClub's budget is exhausted (that retry is a
        // HackClub call too).
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
      // Did THIS attempt's stream finish deliberately (`stop`)? Reset per
      // attempt so a stale stop from a prior model can't mask a truncated one.
      let sawCleanStop = false;
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
        // Deliberately no model name in the output: the thinking block shows
        // only the "Thinking" status, never which model is running.
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
      const attemptAbort = new AbortController();
      const attemptTimer = setTimeout(() => {
        attemptAbort.abort(new AttemptTimeoutError(ATTEMPT_TIMEOUT_MS));
      }, ATTEMPT_TIMEOUT_MS);
      try {
        activeAttempt = currentAttempt;
        if (currentAttempt.model === ROUTER_MODEL) {
          autoHolder = holder;
        }
        reply ??= createReply({ threadId });
        // Surface the model in the thinking section: `in_progress` while this
        // attempt runs, completed exactly once with the resolved model.
        yield {
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
          prompt: promptWithAttachments({
            attachments,
            // On a fallback attempt, replay any tool results already gathered
            // so the new model continues from them instead of re-running them.
            text:
              attempts.length > 0 && gatheredResults.length > 0
                ? `${messageText}\n\n${renderCarryover(gatheredResults)}`
                : messageText,
          }),
          system: systemPrompt({ hints }),
          tools: built.tools,
        });
        // Per-attempt plan side-channel so the subagent can stream its own live
        // task card into this attempt's plan; closed in the finally below.
        const planChannel = new ChunkChannel<string | StreamChunk>();
        emitToPlan = (chunk: StreamChunk) => planChannel.push(chunk);
        for await (const chunk of mergeStream(
          renderStream({
            knownTools,
            onSkip: () => {
              // A skip is a deliberate, successful "no reply".
              skipped = true;
            },
            onTextDelta: async (text) => {
              producedText = true;
              errorStage = 'after_text';
              await reply?.append({ text, thread: turnThread });
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
              if (reason === 'stop') {
                sawCleanStop = true;
              }
            },
            onError: (msg) => {
              // A HackClub daily-spend-limit 429 dooms every HackClub rung.
              if (
                currentAttempt.provider === 'hackclub' &&
                SPEND_LIMIT_PATTERN.test(msg)
              ) {
                hackclubBudgetExhausted = true;
                spendLimitMessage = msg;
              }
            },
            stream: result.fullStream,
          }),
          planChannel
        )) {
          if (errorStage === 'before_output') {
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

        // Reply text or a deliberate skip always counts as handled. Tool
        // activity counts ONLY with a clean `stop` (the model ran tools then
        // deliberately finished); tool activity that ends WITHOUT a clean stop
        // (an empty/truncated synthesis step — the "stops mid-task" bug) falls
        // back so the user actually gets an answer.
        const handled =
          producedText || skipped || (producedToolActivity && sawCleanStop);
        if (!handled) {
          throw new Error(
            producedToolActivity
              ? `Model ${currentAttempt.model} ran tools but ended without a reply (truncated synthesis step).`
              : `Model ${currentAttempt.model} returned an empty response.`
          );
        }
        // Capture usage for the footer (best-effort; never fails the turn).
        if (producedText) {
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
        if (
          currentAttempt.provider === 'hackclub' &&
          SPEND_LIMIT_PATTERN.test(thrownErrorText(error))
        ) {
          hackclubBudgetExhausted = true;
          spendLimitMessage ??= thrownErrorText(error);
        }
        routeNextAttempt();
        const retryAttempt = attempt;
        // Only a turn that already streamed real reply text must not fall back
        // (it would duplicate user-facing output).
        if (controller.signal.aborted || producedText) {
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
            err: errorMessage(error),
            nextAttempt: attemptLog(retryAttempt),
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
}

// Fold an error's message + provider responseBody/data into one string so the
// spend-limit pattern can match text (e.g. "Daily spending limit of $3 reached")
// that lives in responseBody rather than the error message.
function thrownErrorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  const pieces: string[] = [];
  if (error instanceof Error) {
    pieces.push(error.message);
  }
  const record = error as Record<string, unknown> | null;
  if (record) {
    for (const key of ['responseBody', 'data']) {
      const value = record[key];
      if (value != null) {
        pieces.push(typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
  }
  return pieces.length > 0 ? pieces.join(' ') : String(error);
}

function attemptLog(attempt: ModelAttempt | undefined) {
  return attempt
    ? { model: attempt.model, provider: attempt.provider }
    : undefined;
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
