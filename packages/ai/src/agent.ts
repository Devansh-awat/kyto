import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  generateText,
  hasToolCall,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolCallRepairFunction,
  type ToolSet,
} from 'ai';
import { addCacheControl } from './cache-control';
import {
  comparePrefix,
  type PrefixDivergence,
  type PrefixUnit,
  prefixUnits,
} from './cache-probe';
import { createCallMeter } from './call-stats';
import {
  applyTrim,
  COMPACT_AT,
  COMPACT_INSTRUCTION,
  type CompactionEvent,
  compactedMessages,
  estimateMessageTokens,
  LONG_CONTEXT_PRICE_STEP,
  planTrim,
  TRIM_TARGET,
} from './context-trim';
import { fetchWithGatewayRetry, type GatewayRetryInfo } from './gateway-retry';
import { capContextImages } from './image-cap';
import {
  acceptNullOptionals,
  isOpenAiModel,
  nullableToolSchemas,
} from './nullable-optionals';
import {
  ANTHROPIC_ONLY_MODELS,
  GEMINI_PROVIDER,
  GLM_FLASH_MODEL,
  HACKCLUB_PROVIDER,
  HIGH_EFFORT_MAX_OUTPUT_TOKENS,
  LUNA_MODEL,
  MAX_OUTPUT_TOKENS,
  MERCURY_MODEL,
  type ModelAttempt,
  modelSupportsVision,
  PRIMARY_MODEL,
} from './providers/attempts';
import {
  BYOK_DEFAULT_EFFORT,
  BYOK_DEFAULT_OUTPUT_TOKENS,
  BYOK_HIGH_EFFORT_OUTPUT_TOKENS,
} from './providers/byok';
import { CHATGPT_PROVIDER } from './providers/chatgpt';
import { reportSpend } from './spend';
import { stabilizeToolOrder } from './tool-order';

// Ceiling on agentic steps within one attempt (model → tools → model …).
// Effectively "no limit" for real work: a hard 60 used to strand long jobs
// (screenshotting 50 captcha frames, a big scripted scrape) mid-solve, and the
// stop looked like "kyto went quiet in the middle". The real bound on a runaway
// attempt is the wall-clock watchdog (AGENT_ATTEMPT_TIMEOUT_MS) plus the
// degenerate-loop guard, not this counter — so it's set high and overridable.
export const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 1000;

/**
 * The tool that means "this turn is over, say nothing". Its RESULT used to just
 * feed back into the loop like any other, so a model that decided not to answer
 * kept getting asked what to do next: observed as 5+ Thinking→`skip`→Thinking
 * cycles on one message that wasn't even addressed to kyto, only stoppable with
 * `@kyto!stop`, and each cycle billed the shared daily cap for a message kyto
 * had already decided to ignore.
 *
 * A skip is terminal by definition, so it's a stop condition, not a tool result.
 * Named here (not passed in per call site) because every attempt that offers the
 * tool must honour it — a new call site forgetting the flag would re-open the
 * loop — and `hasToolCall` simply never fires for a toolset without it.
 */
export const SKIP_TOOL_NAME = 'skip';

// Same mechanism, opposite reason: `upgradeModel` says "this needs a better
// model than me". Ending the attempt on the call is the whole point — the
// weaker model must not carry on working after asking to be replaced, and the
// agent loop routes the turn onto the escalation rung with the work so far
// replayed as carryover.
export const UPGRADE_TOOL_NAME = 'upgradeModel';

/**
 * Filled in as the attempt runs: `model` is the concrete slug OpenRouter's
 * auto-router resolved to (read off the response body), `calls` counts
 * completions calls (== agentic steps).
 */
export interface ResolvedModelHolder {
  calls?: number;
  model?: string;
  /** The reasoning effort this attempt was sent with (Hack Club only). */
  reasoningEffort?: string;
}

/**
 * An image the model should SEE (not just be told about). Slack image
 * attachments become these on the user turn; the viewImage tool feeds sandbox
 * screenshots in mid-turn. The openai-compatible providers only render images
 * that ride in a USER message — a tool RESULT image is JSON-stringified and lost
 * — so both paths land as user-message file parts (see below).
 */
export interface ImageInput {
  bytes: Uint8Array;
  mediaType: string;
  /** Sandbox path or filename, shown to the model as a label. */
  path?: string;
}

// An image as an AI SDK file part. Bare Uint8Array data + an image media type is
// converted to an OpenAI `image_url` by the openai-compatible provider.
function imagePart(image: ImageInput) {
  return {
    data: image.bytes,
    mediaType: image.mediaType,
    type: 'file' as const,
  };
}

/**
 * Keep only images the SDK's `ModelMessage[]` schema will actually accept.
 *
 * `filePartSchema` requires `mediaType` to be a string and `data` to be one of
 * string / Uint8Array / ArrayBuffer / Buffer. A part that misses either is
 * rejected during prompt construction — BEFORE any request goes out — as
 * `Invalid prompt: The messages do not match the ModelMessage[] schema`, which
 * takes the WHOLE TURN down. Because nothing was ever sent, the failure is
 * identical on every rung: one bad attachment used to burn three models in 28
 * seconds (observed 2026-07-28) and still answer nobody.
 *
 * One unusable image must degrade to "that image was skipped", never to a dead
 * turn — so the invalid parts are dropped here and reported to the caller
 * instead of being handed to the SDK. The prompt text still describes the
 * attachment and its sandbox path, so the model can read the file with a tool.
 */
function usableImages(
  images: ImageInput[],
  onDropped?: (dropped: ImageInput[]) => void
): ImageInput[] {
  const kept: ImageInput[] = [];
  const dropped: ImageInput[] = [];
  for (const image of images) {
    const data: unknown = image?.bytes;
    const dataOk =
      typeof data === 'string' ||
      data instanceof Uint8Array ||
      data instanceof ArrayBuffer;
    const mediaTypeOk =
      typeof image?.mediaType === 'string' && image.mediaType.length > 0;
    if (dataOk && mediaTypeOk) {
      kept.push(image);
    } else {
      dropped.push(image);
    }
  }
  if (dropped.length > 0) {
    onDropped?.(dropped);
  }
  return kept;
}

/**
 * For a text-only model (Mercury 3): every image part becomes the vision
 * model's description of it — the raw image 404s the request, and an image
 * turn that landed on such a model, as its draw or as a fallback, died there.
 * One description per image for the whole attempt (`descriptions`), so every
 * step re-sends the same bytes and the prompt cache holds.
 */
async function describedImageParts({
  abortSignal,
  descriptions,
  messages,
}: {
  abortSignal?: AbortSignal;
  descriptions: Map<unknown, string>;
  messages: ModelMessage[];
}): Promise<ModelMessage[]> {
  const isImage = (part: { mediaType?: unknown; type: string }) =>
    part.type === 'file' &&
    typeof part.mediaType === 'string' &&
    part.mediaType.startsWith('image/');
  let found = false;
  const pending: Promise<void>[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== 'file' || !isImage(part)) {
        continue;
      }
      found = true;
      const { data, mediaType } = part;
      if (descriptions.has(data)) {
        continue;
      }
      if (!(data instanceof Uint8Array)) {
        descriptions.set(data, '[An image was here; it could not be read.]');
        continue;
      }
      descriptions.set(data, '[An image was here; it could not be described.]');
      // Imported here: vision.ts runs its descriptions through streamAttempt.
      pending.push(
        import('./vision')
          .then(({ describeImages }) =>
            describeImages({
              images: [{ bytes: data, mediaType }],
              signal: abortSignal,
            })
          )
          .then((text) => {
            if (text) {
              descriptions.set(
                data,
                `[An image, described for you because you can't see images: ${text}]`
              );
            }
          })
          .catch(() => undefined)
      );
    }
  }
  if (!found) {
    return messages;
  }
  await Promise.all(pending);
  return messages.map((message) =>
    message.role === 'user' && typeof message.content !== 'string'
      ? {
          ...message,
          content: message.content.map((part) =>
            part.type === 'file' && isImage(part)
              ? {
                  text: descriptions.get(part.data) ?? '[An image was here.]',
                  type: 'text' as const,
                }
              : part
          ),
        }
      : message
  );
}

const MODEL_FIELD = /"model"\s*:\s*"([^"]+)"/;
// The resolved slug appears in the first SSE chunk; don't scan forever.
const MAX_SCAN_BYTES = 16_384;
// Room for a dense summary of a ~92k-token context; it replaces all of it.
const COMPACT_SUMMARY_MAX_TOKENS = 8000;

/**
 * Stream one model attempt: the whole multi-step agentic loop on a single
 * OpenAI-compatible endpoint. The per-instance `fetch` (no global patching —
 * the old interceptor died with Pi) tunes the request:
 *  - HackClub requests get `reasoning: { effort: 'medium' }` (the old Pi
 *    thinking level) — max_tokens comes from maxOutputTokens below, which
 *    defuses the proxy's pessimistic daily-spend projection;
 *  - every request gets 1-hour prompt-cache breakpoints (see addCacheControl);
 * and captures the resolved model slug into `holder` from a response clone.
 */
export function streamAttempt({
  abortSignal,
  activeTools,
  attempt,
  holder,
  images,
  getFreshImages,
  history = [],
  onCachePrefix,
  onCompaction,
  onDroppedImages,
  onFirstRequest,
  onError,
  onGatewayRetry,
  continueFrom = [],
  priorInputTokens,
  priorMessages = [],
  prompt,
  reasoningEffort,
  serviceTier,
  source = 'turn',
  system,
  toolOrder,
  tools,
}: {
  abortSignal?: AbortSignal;
  /** Live view of the tool names exposed to the model (deferred loading). */
  activeTools?: () => string[] | undefined;
  attempt: ModelAttempt;
  holder: ResolvedModelHolder;
  /** Images to show the model on the user turn (e.g. Slack image attachments). */
  images?: ImageInput[];
  /**
   * Drained before each step for any images the model asked to view mid-turn
   * (the viewImage tool). Returns the not-yet-shown ones; they are injected as a
   * user message so the model actually sees them on the next step.
   */
  getFreshImages?: () => ImageInput[];
  /**
   * The replayed thread, ONE entry per message, sent as separate user messages
   * ahead of `prompt` with a cache breakpoint on the last one (addCacheControl's
   * H). Joined into the prompt, the history could never be read back from
   * cache on the next turn — see cache-control.ts. Entries must render
   * byte-identically from turn to turn.
   */
  history?: string[];
  /**
   * Called with any images dropped for being unrepresentable as an SDK file
   * part (see usableImages). Silence here would turn "kyto ignored my
   * screenshot" into an unexplainable one-off.
   */
  onDroppedImages?: (dropped: ImageInput[]) => void;
  /**
   * Called for every error the SDK swallows into the stream. Without it the SDK
   * default is `console.error`, which dumped an unstructured AI SDK stack blob
   * into the journal while the turn itself was logged as "complete" — the
   * failure that was impossible to attribute without a Slack transcript.
   */
  onError?: (error: unknown) => void;
  /**
   * Called once per step with where this request's prompt stopped matching the
   * previous step's. Prompt caching is a prefix match, so a step that is not
   * append-only re-bills everything after the divergence — and nothing else
   * reports that: the turn succeeds either way and only the invoice differs.
   */
  onCachePrefix?: (info: PrefixDivergence) => void;
  /**
   * Mid-turn compaction progress (see context-trim.ts): started, done, then the
   * next request's real size once the provider reports it.
   */
  onCompaction?: (event: CompactionEvent) => void;
  /**
   * Called with the prefix units of the attempt's FIRST request, so the caller
   * can compare it with the previous turn's — the cross-turn half of the probe
   * that onCachePrefix can't see, since each attempt starts a fresh one.
   */
  onFirstRequest?: (units: PrefixUnit[]) => void;
  /**
   * Called when a step's request came back a gateway failure and is being sent
   * again (see gateway-retry). Purely observational — the retry happens either
   * way — but without it a proxy degrading from "flaky" to "down" looks like
   * nothing more than turns getting slower.
   */
  onGatewayRetry?: (info: GatewayRetryInfo) => void;
  /**
   * An earlier conversation this call continues, ahead of `history` and
   * `prompt`: a resumed subagent's own run, tool calls and results included.
   */
  priorMessages?: ModelMessage[];
  /**
   * Work an earlier attempt at THIS request already did, after `prompt`: its
   * tool calls and their results, so a fallback model carries on from them.
   */
  continueFrom?: ModelMessage[];
  /**
   * The provider-measured size of the carried messages (`priorMessages` or
   * `continueFrom`) when they were last sent. Past COMPACT_AT of the price
   * step (100k for a model without one), the FIRST request is compacted the
   * way a later step would be, instead of going out whole.
   */
  priorInputTokens?: number;
  prompt: string;
  /**
   * Hack Club only: the effort to send, already decided by the caller (so it
   * can show it). Omitted → `pickReasoningEffort`.
   */
  reasoningEffort?: string;
  /**
   * `flex`: OpenAI's half-price tier, for work nobody is watching live (a
   * Kevinton review, a subagent). Only applied to OpenAI models on Hack Club;
   * a request the flex tier refuses is re-sent once at the normal tier.
   */
  serviceTier?: 'flex';
  /** What this call's bill is filed under in `model_spend` (see spend.ts). */
  source?: string;
  /** One system message, or several in order (see systemPrompt). */
  system: string | string[];
  /**
   * The tool order already sent in this THREAD, so a turn's tools serialize in
   * the order the last turn's did (see stabilizeToolOrder). Per attempt when
   * omitted.
   */
  toolOrder?: { names: string[] };
  tools: ToolSet;
}) {
  // "Sign in with ChatGPT" runs on the ChatGPT (Codex) backend, which speaks the
  // OpenAI **Responses API** (POST …/codex/responses) — NOT chat/completions,
  // which 404s there. So this attempt uses the OpenAI provider's `.responses()`
  // model instead of the openai-compatible chat client, with a fetch that forces
  // `store:false` (Codex rejects the request otherwise). Every other provider is
  // an ordinary openai-compatible chat endpoint.
  const isChatgpt = attempt.provider === CHATGPT_PROVIDER;
  const model = isChatgpt
    ? createOpenAI({
        apiKey: attempt.apiKey,
        baseURL: attempt.baseURL,
        fetch: codexFetch({
          attempt,
          holder,
          onGatewayRetry,
        }) as unknown as typeof fetch,
        // The ChatGPT account-scoping header; Authorization comes from apiKey.
        ...(attempt.headers ? { headers: attempt.headers } : {}),
      }).responses(attempt.model)
    : createOpenAICompatible({
        apiKey: attempt.apiKey,
        baseURL: attempt.baseURL,
        fetch: tunedFetch({
          attempt,
          historyMessages: history.length,
          holder,
          onCachePrefix,
          onFirstRequest,
          onGatewayRetry,
          reasoningEffort,
          serviceTier,
          toolOrder,
        }) as unknown as typeof fetch,
        // Extra per-attempt headers. Authorization is set from apiKey.
        ...(attempt.headers ? { headers: attempt.headers } : {}),
        name: attempt.provider,
      }).chatModel(attempt.model);
  // Attachment images ride in the final user turn (put BEFORE the text so the
  // cache breakpoint still lands on the trailing text block), after the
  // replayed history. With neither, keep the plain string prompt.
  const initialImages = usableImages(images ?? [], onDroppedImages);
  const textOnly = !modelSupportsVision(attempt.model);
  const descriptions = new Map<unknown, string>();
  const promptInput =
    initialImages.length > 0 ||
    history.length > 0 ||
    priorMessages.length > 0 ||
    continueFrom.length > 0
      ? {
          messages: [
            ...priorMessages,
            ...history.map((content) => ({
              content,
              role: 'user' as const,
            })),
            {
              content:
                initialImages.length > 0
                  ? [
                      ...initialImages.map(imagePart),
                      { text: prompt, type: 'text' as const },
                    ]
                  : prompt,
              role: 'user' as const,
            },
            ...continueFrom,
          ] satisfies ModelMessage[],
        }
      : { prompt };
  // Where the request sits, and what a first-request compaction keeps
  // verbatim: a resumed subagent's follow-up, or a fallback's request plus the
  // last tool round it inherited.
  const promptIndex = priorMessages.length + history.length;
  const lastCarriedCall = continueFrom.findLastIndex(
    (message) => message.role === 'assistant'
  );
  const carriedKeepFrom =
    lastCarriedCall === -1 ? promptIndex : promptIndex + 1 + lastCarriedCall;
  const meter = createCallMeter();
  // Set once the call is billed: a call that dies before finishing any step
  // gets neither onFinish nor (unless stopped) onAbort, only a rejected
  // `steps`, and is billed from there instead of vanishing (`!effort`).
  let billed = false;
  const billSteps = (
    steps: Parameters<typeof reportSpend>[0]['steps'],
    ended: 'aborted' | 'error'
  ) => {
    if (billed) {
      return;
    }
    billed = true;
    meter.close(ended);
    reportSpend({
      effort: holder.reasoningEffort ?? reasoningEffort,
      model: attempt.model,
      provider: attempt.byokProvider
        ? `byok:${attempt.byokProvider}`
        : attempt.provider,
      source,
      stats: meter.summary(),
      steps,
    });
  };
  const priceStep = LONG_CONTEXT_PRICE_STEP[attempt.model];
  // How many messages the previous step's request carried: what follows them
  // is the last step's own output, which compaction keeps verbatim.
  let sentLength = 0;
  // A compaction whose real effect the next request's usage will show.
  let pendingMeasure: { before: number; step: number } | undefined;
  const systemInput =
    typeof system === 'string'
      ? system
      : system.map((content) => ({ content, role: 'system' as const }));
  // Asked of the SAME model with the SAME system, tools and messages plus one
  // instruction, so everything up to the instruction reads from cache. Tools
  // are passed without `execute` (same schemas, so the same cached prefix) and
  // `toolChoice` is left alone: changing it invalidates Anthropic's message
  // cache. A tool call instead of text just means no summary.
  const summarizeContext = async ({
    activeToolNames,
    messages,
  }: {
    activeToolNames: string[] | undefined;
    messages: ModelMessage[];
  }): Promise<string | undefined> => {
    const summaryMeter = createCallMeter();
    const billSummary = (steps: Parameters<typeof reportSpend>[0]['steps']) =>
      reportSpend({
        effort: holder.reasoningEffort ?? reasoningEffort,
        model: attempt.model,
        provider: attempt.byokProvider
          ? `byok:${attempt.byokProvider}`
          : attempt.provider,
        source: `${source}-compaction`,
        stats: summaryMeter.summary(),
        steps,
      });
    try {
      const inert: ToolSet = {};
      for (const [name, definition] of Object.entries(tools)) {
        inert[name] = { ...definition, execute: undefined };
      }
      const summary = await generateText({
        abortSignal,
        onLanguageModelCallEnd: (event) => summaryMeter.onEnd(event),
        onLanguageModelCallStart: () => summaryMeter.onStart(),
        ...(activeToolNames ? { activeTools: activeToolNames } : {}),
        maxOutputTokens: COMPACT_SUMMARY_MAX_TOKENS,
        maxRetries: 1,
        messages: [...messages, { content: COMPACT_INSTRUCTION, role: 'user' }],
        model,
        system: systemInput,
        tools: inert,
      });
      billSummary(summary.steps);
      return summary.text.trim() || undefined;
    } catch (error) {
      summaryMeter.onError(error);
      summaryMeter.close(abortSignal?.aborted ? 'aborted' : 'error');
      billSummary([]);
      return;
    }
  };
  let defaultOutputTokens =
    reasoningEffort === 'high'
      ? HIGH_EFFORT_MAX_OUTPUT_TOKENS
      : MAX_OUTPUT_TOKENS;
  // A key owner's blank cap gets room for its thinking: it's their key. Their
  // own effort counts when the caller chose none (the request tuner sends it).
  if (attempt.byokProvider !== undefined) {
    defaultOutputTokens =
      (reasoningEffort ?? attempt.reasoningEffort) === 'high'
        ? BYOK_HIGH_EFFORT_OUTPUT_TOKENS
        : BYOK_DEFAULT_OUTPUT_TOKENS;
  }
  const result = streamText({
    ...promptInput,
    abortSignal,
    // Cap output on every metered path: HackClub (pessimistic spend projection)
    // and a user's own BYOK key (real tokens on THEIR account) — reasoning
    // models otherwise burn unbounded thinking tokens on someone's bill.
    ...(attempt.provider === HACKCLUB_PROVIDER ||
    attempt.byokProvider !== undefined
      ? {
          maxOutputTokens: attempt.maxOutputTokens ?? defaultOutputTokens,
        }
      : {}),
    // We run our own fallback chain across providers, so the SDK's default of 3
    // internal tries per attempt just triples the wait before we can route
    // away from a rate-limited or budget-exhausted proxy. One retry still
    // absorbs a genuinely transient blip.
    maxRetries: 1,
    // A tool call whose arguments were cut off mid-JSON (the model tried to
    // write a huge file / post a huge message and hit maxOutputTokens) otherwise
    // dies as an unrecoverable AI_JSONParseError.
    experimental_repairToolCall: repairTruncatedToolCall,
    model,
    // Mirror the Codex client on a ChatGPT turn. `store: false` has to be told
    // to the SDK, not just forced onto the wire body (codexFetch): knowing it,
    // the provider asks for `include: reasoning.encrypted_content` and replays
    // reasoning items WITH their payload instead of by `rs_…` id. Without it
    // every multi-step tool turn died at the second step with a 404 "Item with
    // id 'rs_…' not found. Items are not persisted when `store` is set to
    // false" — which is what made ChatGPT turns fall back to the shared models
    // so much more often than the same account does in Codex itself.
    ...(isChatgpt
      ? {
          providerOptions: {
            openai: { reasoningSummary: 'auto', store: false },
          },
        }
      : {}),
    onError: ({ error }) => {
      meter.onError(error);
      if (onError) {
        onError(error);
      } else {
        // The SDK's own default, kept for callers that pass no handler.
        console.error(error);
      }
    },
    ...(activeTools ||
    getFreshImages ||
    priceStep ||
    priorInputTokens ||
    textOnly
      ? {
          // Gate deferred tools per step AND inject any images the model asked to
          // view: the SDK renders images only in a user message, so a screenshot
          // the model loaded mid-turn is appended as a user turn here (the
          // override carries forward, so it stays visible on later steps).
          prepareStep: async ({
            initialMessages,
            messages,
            stepNumber,
            steps,
          }) => {
            const result: {
              activeTools?: never[];
              messages?: ModelMessage[];
            } = {};
            if (activeTools) {
              result.activeTools = activeTools() as never[] | undefined;
            }
            // Same filter as the initial images: prepareStep's messages are not
            // re-validated by the SDK, so a bad part here dies later and less
            // legibly, in prompt CONVERSION rather than validation.
            const fresh = usableImages(
              getFreshImages?.() ?? [],
              onDroppedImages
            );
            let stepMessages = messages;
            // Past COMPACT_AT of the price step by the provider's own count,
            // the model summarizes everything but the system prompt and
            // tools. Step 0 is the replayed thread, which thread compaction
            // bounds. See context-trim.ts.
            // The first request of a call that carries earlier work is
            // measured by that work's last request (priorInputTokens).
            const first = stepNumber === 0;
            const lastInput = first
              ? priorInputTokens
              : steps.at(-1)?.usage.inputTokens;
            const ceiling =
              priceStep ?? (first ? CARRIED_COMPACT_STEP : undefined);
            const keepFrom = first ? carriedKeepFrom : sentLength;
            if (
              ceiling &&
              lastInput !== undefined &&
              lastInput > ceiling * COMPACT_AT
            ) {
              onCompaction?.({
                before: lastInput,
                phase: 'start',
                step: stepNumber,
              });
              // The summary request is the last one plus what that step
              // appended. If the appended results would carry it past the
              // step, they are cut in the summary request only: they are not
              // cached yet, and they are kept whole after the summary anyway.
              const appended =
                lastInput + estimateMessageTokens(messages.slice(keepFrom));
              const summary = await summarizeContext({
                activeToolNames: activeTools?.(),
                messages:
                  appended > ceiling
                    ? applyTrim({
                        messages,
                        picks: planTrim({
                          fromIndex: first ? 0 : sentLength,
                          messages,
                          target: ceiling * COMPACT_AT,
                          tokens: appended,
                        }).picks,
                      })
                    : messages,
              });
              if (summary) {
                stepMessages = compactedMessages({
                  lastStepFrom: keepFrom,
                  messages,
                  request: first
                    ? messages[promptIndex]
                    : initialMessages.at(-1),
                  summary,
                });
              } else {
                const plan = planTrim({
                  fromIndex: first ? 0 : initialMessages.length,
                  messages,
                  target: ceiling * TRIM_TARGET,
                  tokens: appended,
                });
                stepMessages = applyTrim({ messages, picks: plan.picks });
              }
              const estimatedAfter =
                appended -
                estimateMessageTokens(messages) +
                estimateMessageTokens(stepMessages);
              onCompaction?.({
                before: lastInput,
                estimatedAfter,
                phase: 'done',
                step: stepNumber,
                summarized: summary !== undefined,
              });
              pendingMeasure = { before: lastInput, step: stepNumber };
            }
            if (fresh.length > 0) {
              const label = fresh
                .map((image) => image.path ?? 'image')
                .join(', ');
              stepMessages = [
                ...stepMessages,
                {
                  content: [
                    ...fresh.map(imagePart),
                    {
                      text: `[You are now viewing the image(s) you loaded: ${label}]`,
                      type: 'text' as const,
                    },
                  ],
                  role: 'user' as const,
                },
              ];
            }
            if (textOnly) {
              stepMessages = await describedImageParts({
                abortSignal,
                descriptions,
                messages: stepMessages,
              });
            }
            const capped = capContextImages({ messages: stepMessages });
            if (capped !== messages) {
              result.messages = capped;
            }
            sentLength = capped.length;
            return result;
          },
        }
      : {}),
    // Either bound ends the attempt: the step ceiling, or a deliberate skip
    // (see SKIP_TOOL_NAME — without this the "no reply" decision was made over
    // and over on the same message).
    stopWhen: [
      stepCountIs(MAX_STEPS),
      hasToolCall(SKIP_TOOL_NAME),
      hasToolCall(UPGRADE_TOOL_NAME),
    ],
    // An aborted attempt (a stop, the watchdog, an interrupt) was paid for
    // too, step by step.
    onAbort: ({ steps }) => billSteps(steps, 'aborted'),
    onChunk: ({ chunk }) => meter.onChunk(chunk.type),
    // A request still open at the finish died after earlier steps finished.
    onFinish: ({ steps }) => billSteps(steps, 'error'),
    onLanguageModelCallEnd: (event) => meter.onEnd(event),
    onLanguageModelCallStart: () => meter.onStart(),
    onStepEnd: ({ usage }) => {
      if (pendingMeasure && usage.inputTokens !== undefined) {
        onCompaction?.({
          after: usage.inputTokens,
          ...pendingMeasure,
          phase: 'measured',
        });
        pendingMeasure = undefined;
      }
    },
    system: systemInput,
    tools: acceptNullOptionals(tools),
  });
  // `steps` rejects only when no step finished: the call's one row then.
  result.steps.then(undefined, () =>
    billSteps([], abortSignal?.aborted ? 'aborted' : 'error')
  );
  return result;
}

/**
 * Salvage a tool call whose argument JSON was cut off mid-stream — the model
 * tried to emit a large `content` (writeFile) or `text` (postMessage) and ran
 * into `maxOutputTokens`, so the arguments arrive as an unterminated JSON
 * fragment. The SDK's default is to throw `InvalidToolInputError`, which surfaces
 * as an unrecoverable error and strands the turn.
 *
 * Closing the open string/array/object brackets turns the fragment back into
 * valid JSON, so the call runs with the content that DID arrive rather than the
 * turn dying. The model sees the (short) result and can continue the file with
 * an append. Returns null when the fragment can't be closed into valid JSON, in
 * which case the SDK's normal error path takes over.
 */
// Only tools whose long field is CONTENT. A command tool cut off mid-argument
// must not run the prefix that arrived: `rm -rf /work/old-proj` cut from
// `…-proj/tmp`, or `gh repo delete foo` cut from `foo-bar`.
const REPAIRABLE_TOOLS = new Set(['postMessage', 'writeFile']);

const repairTruncatedToolCall: ToolCallRepairFunction<ToolSet> = ({
  toolCall,
}) => {
  if (!REPAIRABLE_TOOLS.has(toolCall.toolName)) {
    return Promise.resolve(null);
  }
  const closed = closeTruncatedJson(toolCall.input);
  return Promise.resolve(
    closed === null ? null : { ...toolCall, input: closed }
  );
};

// Walk the fragment tracking string/escape state and the bracket stack, then
// append whatever closers are still owed. A fragment that ends mid-escape or
// mid-key is dropped back to the last safe point first.
function closeTruncatedJson(input: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      stack.pop();
    }
  }
  // A trailing backslash would escape the quote we're about to add.
  let repaired = escaped ? input.slice(0, -1) : input;
  if (inString) {
    repaired += '"';
  } else {
    // A fragment cut after a separator ("a":1,) can't be closed as-is.
    repaired = repaired.replace(/,\s*$/, '');
  }
  while (stack.length > 0) {
    repaired += stack.pop();
  }
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

// Fetch for the ChatGPT (Codex) Responses API. The AI SDK's OpenAI provider
// already sends the right Responses shape (`input` as a list, `stream:true`),
// but the Codex backend additionally REQUIRES `store:false` (it 400s "Store must
// be set to false" otherwise). So this injects that into every /responses body
// and counts the call as an agentic step. The account-scoping header rides on
// the provider's `headers`, and Authorization on `apiKey`.
function codexFetch({
  attempt,
  holder,
  onGatewayRetry,
}: {
  attempt: ModelAttempt;
  holder: ResolvedModelHolder;
  onGatewayRetry?: (info: GatewayRetryInfo) => void;
}): FetchLike {
  return async (input, init) => {
    const url = requestUrl(input);
    if (!url.includes('/responses')) {
      return fetch(input as Parameters<typeof fetch>[0], init);
    }
    holder.calls = (holder.calls ?? 0) + 1;
    holder.model ??= attempt.model;
    const raw = await readRequestBody(input, init);
    if (raw === undefined) {
      return fetch(input as Parameters<typeof fetch>[0], init);
    }
    let body = raw;
    try {
      // Belt and braces: the provider already sets store:false from
      // providerOptions (which is what makes it request encrypted reasoning
      // content), but Codex rejects a stored request outright, so pin it here
      // too in case an SDK update stops threading the option through.
      const payload = JSON.parse(raw) as Record<string, unknown>;
      payload.store = false;
      nullableToolSchemas(payload);
      body = JSON.stringify(payload);
    } catch {
      // Un-parseable body: send it through unchanged rather than dropping it.
      return fetch(input as Parameters<typeof fetch>[0], init);
    }
    const source =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(
      source as ConstructorParameters<typeof Headers>[0]
    );
    headers.delete('content-length');
    return fetchWithGatewayRetry(
      url,
      {
        ...init,
        body,
        headers,
        method:
          init?.method ?? (input instanceof Request ? input.method : 'POST'),
        signal:
          init?.signal ?? (input instanceof Request ? input.signal : undefined),
      },
      { onRetry: onGatewayRetry }
    );
  };
}

const PROMPT_CACHE_KEY = 'kyto';

function tunedFetch({
  attempt,
  historyMessages,
  holder,
  onCachePrefix,
  onFirstRequest,
  onGatewayRetry,
  reasoningEffort: effort,
  serviceTier,
  toolOrder = { names: [] },
}: {
  attempt: ModelAttempt;
  historyMessages: number;
  reasoningEffort?: string;
  holder: ResolvedModelHolder;
  onCachePrefix?: (info: PrefixDivergence) => void;
  onFirstRequest?: (units: PrefixUnit[]) => void;
  onGatewayRetry?: (info: GatewayRetryInfo) => void;
  serviceTier?: 'flex';
  toolOrder?: { names: string[] };
}): FetchLike {
  // Gemini 3.x attaches an encrypted `thought_signature` to every function call
  // and REQUIRES it echoed back on the next turn, or it 400s ("Function call is
  // missing a thought_signature"). The OpenAI-compat SDK drops that field when
  // it replays assistant tool calls, so we capture signatures off each response
  // (keyed by tool-call id) and re-inject them into subsequent request bodies.
  // Scoped to this attempt's closure so it persists across the attempt's steps.
  const thoughtSignatures = new Map<string, string>();
  const isGemini = attempt.provider === GEMINI_PROVIDER;
  // The previous request's prefix units, so each step can be checked for cache
  // churn against the one before it. Per-attempt closure, same as the
  // signatures above.
  const cacheProbe: { units: PrefixUnit[] } = { units: [] };
  // Flex is OpenAI's tier, and Hack Club is the only provider here that passes
  // it through; anywhere else the field is at best ignored.
  const flex =
    serviceTier === 'flex' &&
    attempt.provider === HACKCLUB_PROVIDER &&
    attempt.model.startsWith('openai/');
  const byokDefaultEffort =
    effort === undefined && OPENROUTER_FORMAT_BYOK.has(attempt.provider);
  // A `--reasoning` flag or the low-effort retry wins over the key's own pick.
  const reasoningEffort = byokDefaultEffort
    ? (attempt.reasoningEffort ?? BYOK_DEFAULT_EFFORT)
    : (effort ?? pickReasoningEffort({ attempt }).effort);
  if (attempt.provider === HACKCLUB_PROVIDER) {
    holder.reasoningEffort = reasoningEffort;
  }
  return async (input, init) => {
    const url = requestUrl(input);
    let callInput = input;
    let callInit = init;
    if (url.includes('/chat/completions')) {
      holder.calls = (holder.calls ?? 0) + 1;
      const tuned = tuneBody(
        await readRequestBody(input, init),
        attempt,
        isGemini ? thoughtSignatures : undefined,
        onCachePrefix
          ? { onCachePrefix, onFirstRequest, state: cacheProbe }
          : undefined,
        toolOrder,
        {
          explicitEffort: effort !== undefined || byokDefaultEffort,
          flex,
          historyMessages,
          reasoningEffort,
        }
      );
      if (tuned) {
        const source =
          init?.headers ??
          (input instanceof Request ? input.headers : undefined);
        // Recompute Content-Length: the tuned body is longer, and a stale
        // length truncates the request on the wire (silently dropping the
        // appended plugins — the old "allowlist ignored" bug).
        const headers = new Headers(
          source as ConstructorParameters<typeof Headers>[0]
        );
        headers.delete('content-length');
        callInput = url;
        callInit = {
          ...init,
          body: tuned,
          headers,
          method:
            init?.method ?? (input instanceof Request ? input.method : 'POST'),
          signal:
            init?.signal ??
            (input instanceof Request ? input.signal : undefined),
        };
      }
    }
    let response = await fetchWithGatewayRetry(callInput, callInit, {
      onRetry: onGatewayRetry,
    });
    // Flex does not fall back to standard capacity on its own — OpenRouter
    // surfaces the refusal instead. A turn must not walk the fallback ladder
    // just because the cheap tier was full, so ask once more at the normal one.
    if (flex && !response.ok && typeof callInit?.body === 'string') {
      await response.body?.cancel().catch(() => undefined);
      const payload = JSON.parse(callInit.body) as Record<string, unknown>;
      payload.service_tier = undefined;
      response = await fetchWithGatewayRetry(
        callInput,
        { ...callInit, body: JSON.stringify(payload) },
        { onRetry: onGatewayRetry }
      );
    }
    if (response.body && !holder.model && url.includes('/chat/completions')) {
      // clone() tees: the original streams to the SDK untouched; we scan the
      // copy in the background for the resolved model slug.
      readResolvedModel(
        response.clone().body as ReadableStream<Uint8Array>
      ).then((model) => {
        if (model && !holder.model) {
          holder.model = model;
        }
      });
    }
    if (isGemini && response.body && url.includes('/chat/completions')) {
      // Capture this response's thought signatures (background tee) so the next
      // request can echo them back — see the closure comment above.
      captureThoughtSignatures(
        response.clone().body as ReadableStream<Uint8Array>,
        thoughtSignatures
      ).catch(() => undefined);
    }
    return response;
  };
}

// Models whose deployment REQUIRES an exact `top_p`, rejecting the request
// outright otherwise: `{"error":{"message":"top_p must be 0.95 for this
// model","type":"invalid_request_error"}}` with a 400. The AI SDK sends no
// `top_p` unless asked to, and such a provider treats "absent" as wrong rather
// than substituting its own default, so the rung is unusable from the day it is
// added — visible only as a 400 in the journal partway down a fallback walk.
// Keyed by model slug; empty today (the DigitalOcean roster that needed it is
// gone), kept because the failure mode is invisible without it.
const REQUIRED_TOP_P: Record<string, number> = {};

// OpenRouter's upstream precision labels kyto accepts — see tuneBody.
const ALLOWED_QUANTIZATIONS = ['fp8', 'fp16', 'bf16', 'fp32', 'unknown'];
// GLM 5.3 Flash: the fastest host at or under the cheap tier's price (owner's
// call 2026-10-13, on a $3/day cap). Cached reads are ~90% of kyto's GLM bill,
// and the $0.084 in / $0.28 out tier caches at $0.017/M against $0.03 at the
// $0.15/$0.50 tier — ~44% less for ~1/3 less speed (81 vs 122 tok/s,
// measured per host 2026-10-13). Unsorted, OpenRouter's price-weighted spread
// landed on 15-85 tok/s hosts. fp4 stays out. Hosts: MODELS.md.
const GLM_FLASH_ROUTING = {
  max_price: { completion: 0.28, prompt: 0.084 },
  quantizations: ALLOWED_QUANTIZATIONS,
  sort: 'throughput',
};
// BYOK endpoints that speak OpenRouter's `reasoning: { effort }`; OpenAI's own
// API calls it `reasoning_effort` and rejects the unknown field.
const OPENROUTER_FORMAT_BYOK = new Set(['byok-hackclub', 'byok-openrouter']);
// "Too big" for a carried conversation on a model with no price step.
const CARRIED_COMPACT_STEP = 100_000;

// Each accepted by luna (2026-10-09) and haiku (2026-10-10) through the proxy.
// `high` joined the draw on 2026-10-16 (owner's call), to be compared on the
// reasoning metrics the turn logs now carry.
const EXPERIMENT_EFFORTS = ['low', 'medium', 'high'] as const;

/** What `--reasoning` accepts — all four passed the proxy on both models. */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;

/**
 * The effort experiment (issue #36, owner's calls 2026-10-09 for luna and
 * 2026-10-10 for haiku), logged with the turn so speed and quality can be
 * compared per model and effort from thread_logs. Mercury joined the draw with
 * the model experiment (2026-10-20). Every other model: medium.
 *
 * `none` left the draw (owner's call 2026-10-12), `high` joined it
 * (2026-10-16). Haiku draws per attempt: Anthropic caches low and medium
 * together (measured), and high is expected to share it (thinking stays on;
 * unmeasured, the `cross-turn prefix` log shows it). A live turn's luna
 * effort is Jev's alone (apps/bot tool-preload), never drawn here: luna keeps
 * one cache per effort, so a thread only ever goes up.
 */
const EFFORT_DRAW_MODELS = new Set([LUNA_MODEL, MERCURY_MODEL, PRIMARY_MODEL]);

export function pickReasoningEffort({ attempt }: { attempt: ModelAttempt }): {
  effort: string;
  random: boolean;
} {
  if (!EFFORT_DRAW_MODELS.has(attempt.model)) {
    return { effort: 'medium', random: false };
  }
  return {
    effort:
      EXPERIMENT_EFFORTS[
        Math.floor(Math.random() * EXPERIMENT_EFFORTS.length)
      ] ?? 'medium',
    random: true,
  };
}

export function tuneBody(
  raw: string | undefined,
  attempt: ModelAttempt,
  thoughtSignatures?: Map<string, string>,
  probe?: {
    onCachePrefix: (info: PrefixDivergence) => void;
    onFirstRequest?: (units: PrefixUnit[]) => void;
    state: { units: PrefixUnit[] };
  },
  toolOrder?: { names: string[] },
  {
    explicitEffort = false,
    flex,
    historyMessages,
    reasoningEffort,
  }: {
    explicitEffort?: boolean;
    flex: boolean;
    historyMessages: number;
    reasoningEffort: string;
  } = {
    flex: false,
    historyMessages: 0,
    reasoningEffort: 'medium',
  }
): string | null {
  if (raw === undefined) {
    return null;
  }
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    let changed = false;
    // BEFORE the probe, because this one genuinely changes the bytes we send and
    // the probe should measure what the provider actually gets.
    if (toolOrder && stabilizeToolOrder(payload, toolOrder)) {
      changed = true;
    }
    if (isOpenAiModel(attempt.model) && nullableToolSchemas(payload)) {
      changed = true;
    }
    // Measured on the RAW payload, before the rewrites below: addCacheControl
    // moves a breakpoint every step, which would read as prefix churn that the
    // provider never sees.
    if (probe) {
      const units = prefixUnits(payload);
      if (probe.state.units.length === 0) {
        probe.onFirstRequest?.(units);
      }
      const divergence = comparePrefix(probe.state.units, units);
      probe.state.units = units;
      if (divergence) {
        probe.onCachePrefix(divergence);
      }
    }
    // Gemini: re-attach captured thought signatures to assistant tool calls so
    // the API accepts the replayed history (see tunedFetch's closure comment).
    if (
      thoughtSignatures &&
      injectThoughtSignatures(payload, thoughtSignatures)
    ) {
      changed = true;
    }
    // Some deployments pin a sampling parameter and reject anything else —
    // including OMITTING it, which is what the SDK does by default. See
    // REQUIRED_TOP_P: a rung that needs this and doesn't get it 400s on every
    // single turn, and the fallback walk silently skips straight past it.
    const requiredTopP = REQUIRED_TOP_P[attempt.model];
    if (requiredTopP !== undefined && payload.top_p !== requiredTopP) {
      payload.top_p = requiredTopP;
      changed = true;
    }
    // Hack Club's proxy is OpenRouter, which spreads a model over ~30 upstream
    // hosts; the fp4 ones turned GLM 5.3 flash into word salad on long
    // contexts (2026-09-30: "spectroscopy", "photon-for-photon kinship" in
    // #kyto, reproduced 1 in 2 on fp4 at ~30k tokens, 0 in 3 elsewhere). Only
    // 8-bit-or-better hosts may serve kyto; `unknown` keeps Together,
    // Fireworks & co, which don't label theirs.
    if (
      attempt.provider === HACKCLUB_PROVIDER &&
      payload.provider === undefined
    ) {
      if (ANTHROPIC_ONLY_MODELS.has(attempt.model)) {
        payload.provider = { allow_fallbacks: false, only: ['anthropic'] };
      } else if (attempt.model === GLM_FLASH_MODEL) {
        payload.provider = GLM_FLASH_ROUTING;
      } else {
        payload.provider = { quantizations: ALLOWED_QUANTIZATIONS };
      }
      changed = true;
    }
    // A BYOK key on an OpenRouter-format endpoint gets the caller's effort, or
    // BYOK_DEFAULT_EFFORT: unset, GLM thinks at its own default (`max`) until
    // the output cap and returns no text at all (issues #73, #95).
    const takesReasoning =
      attempt.provider === HACKCLUB_PROVIDER ||
      (explicitEffort && OPENROUTER_FORMAT_BYOK.has(attempt.provider));
    if (takesReasoning && payload.reasoning === undefined) {
      payload.reasoning = { effort: reasoningEffort };
      changed = true;
    }
    // One routing hint shared by EVERY thread (coolton's design, 2026-09-29):
    // the system prompt and tools are byte-identical across threads on purpose,
    // so any warm cache anywhere is a usable one. Measured through the proxy on
    // glm-5.3-flash: 11/12 repeats read the ~4.6k-token prefix from cache with
    // it, 10/12 without — a nudge, not a fix; the cache_control marks below do
    // the real work. Hack Club only: another provider may 400 on the field.
    if (
      attempt.provider === HACKCLUB_PROVIDER &&
      payload.prompt_cache_key === undefined
    ) {
      payload.prompt_cache_key = PROMPT_CACHE_KEY;
      changed = true;
    }
    // Prompt caching: mark the large, stable prefix (system prompt + tool
    // schemas) and the moving conversation tail with cache_control breakpoints.
    // Anthropic/Gemini honor these for ~10x cheaper cached reads (verified
    // through the HackClub proxy); providers that don't support explicit
    // caching (OpenAI, DeepSeek, GLM, Kimi, …) safely ignore them and auto-cache
    // on their own. Applied to every attempt — harmless where unsupported.
    if (flex && payload.service_tier === undefined) {
      payload.service_tier = 'flex';
      changed = true;
    }
    if (addCacheControl(payload, { historyMessages })) {
      changed = true;
    }
    return changed ? JSON.stringify(payload) : null;
  } catch {
    return null;
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

async function readRequestBody(
  input: string | URL | Request,
  init: RequestInit | undefined
): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (input instanceof Request) {
    return await input
      .clone()
      .text()
      .catch(() => undefined);
  }
  return;
}

// Re-attach captured Gemini thought signatures to the assistant tool calls in a
// request body, keyed by tool-call id. Google requires each replayed function
// call to carry the signature it was originally issued with.
function injectThoughtSignatures(
  payload: Record<string, unknown>,
  signatures: Map<string, string>
): boolean {
  if (!Array.isArray(payload.messages)) {
    return false;
  }
  let changed = false;
  for (const message of payload.messages as Record<string, unknown>[]) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls as Record<string, unknown>[]) {
      const id = typeof call.id === 'string' ? call.id : undefined;
      // A call carried over from another model's attempt (carriedMessages in
      // the bot) never had a Gemini signature; Google's documented value for
      // a call it didn't produce lets it through validation.
      const signature = id
        ? (signatures.get(id) ??
          (id.startsWith('carried-') ? CARRIED_CALL_SIGNATURE : undefined))
        : undefined;
      if (!signature) {
        continue;
      }
      const existing =
        typeof call.extra_content === 'object' && call.extra_content
          ? (call.extra_content as Record<string, unknown>)
          : {};
      call.extra_content = {
        ...existing,
        google: { thought_signature: signature },
      };
      changed = true;
    }
  }
  return changed;
}

const CARRIED_CALL_SIGNATURE = 'skip_thought_signature_validator';

// Max bytes to scan of a Gemini response for thought signatures — they ride on
// the tool-call delta, which is near the start, but text/reasoning can precede
// it, so allow generous headroom without reading an unbounded stream.
const MAX_SIGNATURE_SCAN_BYTES = 512 * 1024;

// Tee of a Gemini streaming response: parse SSE `data:` lines and record each
// tool call's `extra_content.google.thought_signature` by tool-call id.
async function captureThoughtSignatures(
  body: ReadableStream<Uint8Array>,
  signatures: Map<string, string>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let scanned = 0;
  try {
    while (scanned < MAX_SIGNATURE_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      scanned += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        recordSignatureLine(buffer.slice(0, newline), signatures);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
  } catch {
    // Best-effort: a missed signature just re-surfaces the original 400, which
    // the fallback machinery already handles.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function recordSignatureLine(
  line: string,
  signatures: Map<string, string>
): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return;
  }
  const data = trimmed.slice('data:'.length).trim();
  if (!data || data === '[DONE]') {
    return;
  }
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    return;
  }
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return;
  }
  for (const choice of choices) {
    const toolCalls = (choice as { delta?: { tool_calls?: unknown } }).delta
      ?.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const call of toolCalls) {
      const id = (call as { id?: unknown }).id;
      const signature = (
        call as {
          extra_content?: { google?: { thought_signature?: unknown } };
        }
      ).extra_content?.google?.thought_signature;
      if (typeof id === 'string' && typeof signature === 'string') {
        signatures.set(id, signature);
      }
    }
  }
}

async function readResolvedModel(
  body: ReadableStream<Uint8Array>
): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let scanned = '';
  try {
    while (scanned.length < MAX_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      scanned += decoder.decode(value, { stream: true });
      const match = scanned.match(MODEL_FIELD);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Capturing the model is purely cosmetic.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return;
}
