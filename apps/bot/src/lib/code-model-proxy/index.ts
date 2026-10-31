import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/env';
import logger from '@/lib/logger';

// The model endpoint of the sandbox coding agent (the `codingAgent` tool). The
// agent runs IN the sandbox, but the key to the model endpoint must not: it is
// the owner's whole router key (every combo, paid ones included), and anything
// the agent runs or clones could read it from the environment. So, like the
// Slack and GitHub proxies, the sandbox holds a per-run secret, and this route
// adds the real key and forces the model before forwarding.

const CODE_MODEL_PROXY_PREFIX = '/_codemodel/v1/';
const CHAT_PATH = 'chat/completions';
// A run is capped at 18 minutes; the secret is also revoked when it ends.
const TOKEN_TTL_MS = 30 * 60 * 1000;
// Model calls one run may make: a looping agent stops here instead of burning
// the router's free-tier rate limits for every other run.
const CALL_BUDGET = 400;
// A request carries the whole conversation; past this something is wrong.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOKENS_PER_MILLION = 1_000_000;

// List prices in USD per million tokens (OpenRouter, 2026-10-31), keyed by the
// model id after any router prefix. The provider bills its own way and shows
// kyto nothing, so each call's and run's cost is logged at these to see where
// the budget goes (owner's ask). A model missing here logs tokens only.
const LIST_PRICES: Record<
  string,
  { cachedInput: number; input: number; output: number }
> = {
  'claude-haiku-4-5': { cachedInput: 0.1, input: 1, output: 5 },
  'claude-sonnet-5': { cachedInput: 0.2, input: 2, output: 10 },
  'glm-5.3': { cachedInput: 0.069, input: 0.07, output: 1.4 },
  'kimi-k3': { cachedInput: 0.182, input: 0.192, output: 15 },
};

/**
 * The models runs alternate between: CODE_MODEL is one model or a comma list.
 * Per RUN, not per call — switching mid-run would throw away the prompt cache.
 */
function codeModels(): string[] {
  return env.CODE_MODEL.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}
let runsStarted = 0;

const usageSchema = z.looseObject({
  completion_tokens: z.number().optional(),
  prompt_tokens: z.number().optional(),
  prompt_tokens_details: z
    .looseObject({ cached_tokens: z.number().nullish() })
    .nullish(),
});

interface Usage {
  cachedTokens: number;
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
}

function priceUsage({
  model,
  usage,
}: {
  model: string;
  usage: z.infer<typeof usageSchema>;
}): Usage {
  const inputTokens = usage.prompt_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const price = LIST_PRICES[model.split('/').pop() ?? model];
  if (!price) {
    return { cachedTokens, inputTokens, outputTokens };
  }
  const costUsd =
    ((inputTokens - cachedTokens) * price.input +
      cachedTokens * price.cachedInput +
      outputTokens * price.output) /
    TOKENS_PER_MILLION;
  return { cachedTokens, costUsd, inputTokens, outputTokens };
}

interface CodeModelToken {
  calls: number;
  expiry: number;
  model: string;
  /** Short id tying one run's call lines together in the log. */
  run: string;
  totals: Usage;
}

// In-memory only: a restart ends every run anyway.
const tokens = new Map<string, CodeModelToken>();

// An exhausted route (the router's "All credentials … are cooling down", "Free
// usage limit reached", a 402) answers every retry the same way, and the agent
// retried it until its request timeout: 174s, then a blind `continue` retry
// cost another 108s, in a turn that delivered nothing (#154). The first such
// answer marks that model down; until then its calls get a 400 at once — a
// status the agent does not retry — and a new run takes another model, or the
// tool refuses to start one when every model is down.
const ROUTE_DOWN_MS = 10 * 60 * 1000;
// A bare 429 with no quota wording is more likely a per-minute limit.
const RATE_LIMITED_MS = 60 * 1000;
const QUOTA_TEXT =
  /cooling down|usage limit|quota|insufficient[ _-]?(?:credits|balance|funds)|subscribe to|payment required/i;
// Only the head of a streamed body is read for an error event.
const SNIFF_CHARS = 4000;

const routeDown = new Map<string, { message: string; until: number }>();

function modelDown(
  model: string
): { message: string; until: number } | undefined {
  const down = routeDown.get(model);
  if (down && Date.now() > down.until) {
    routeDown.delete(model);
    return;
  }
  return down;
}

/** When EVERY coding model's route is exhausted: the one back soonest. */
export function codeModelRouteDown():
  | { message: string; until: number }
  | undefined {
  let soonest: { message: string; until: number } | undefined;
  for (const model of codeModels()) {
    const down = modelDown(model);
    if (!down) {
      return;
    }
    if (!soonest || down.until < soonest.until) {
      soonest = down;
    }
  }
  return soonest;
}

function noteRouteAnswer({
  model,
  status,
  text,
}: {
  model: string;
  status: number;
  text: string;
}) {
  const quota = status === 402 || QUOTA_TEXT.test(text);
  if (quota || status === 429) {
    const down = {
      message:
        text.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${status}`,
      until: Date.now() + (quota ? ROUTE_DOWN_MS : RATE_LIMITED_MS),
    };
    routeDown.set(model, down);
    logger.warn(
      { model, status, text: down.message },
      '[code-model] route down'
    );
  }
}

const chatBodySchema = z.looseObject({ messages: z.array(z.unknown()) });

const streamChunkSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z.looseObject({ tool_calls: z.unknown().optional() }).nullish(),
        finish_reason: z.string().nullish(),
      })
    )
    .nullish(),
  usage: usageSchema.nullish(),
});

/** Whether the coding agent has a model to run on. */
export function codeModelConfigured(): boolean {
  return Boolean(
    env.SITES_ENABLED &&
      env.CODE_MODEL_BASE_URL &&
      env.CODE_MODEL_API_KEY &&
      codeModels().length > 0
  );
}

/** Mint one run's secret and the env that points the agent at this proxy. */
export function registerCodeModelToken(): {
  env: Record<string, string>;
  revoke: () => void;
} {
  const secret = randomBytes(24).toString('base64url');
  const models = codeModels();
  // Half and half (owner's call 2026-10-31), skipping a model that is down.
  const up = models.filter((model) => !modelDown(model));
  const pool = up.length > 0 ? up : models;
  const model = pool[runsStarted % pool.length] ?? env.CODE_MODEL;
  runsStarted += 1;
  const token: CodeModelToken = {
    calls: 0,
    expiry: Date.now() + TOKEN_TTL_MS,
    model,
    run: randomBytes(4).toString('hex'),
    totals: { cachedTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
  };
  tokens.set(secret, token);
  return {
    env: {
      KYTO_CODE_MODEL_TOKEN: secret,
      KYTO_CODE_MODEL_URL: `https://${env.SITES_PUBLIC_HOST}/_codemodel/v1`,
    },
    revoke: () => {
      if (tokens.delete(secret) && token.calls > 0) {
        logger.info(
          {
            calls: token.calls,
            model: token.model,
            run: token.run,
            ...token.totals,
          },
          '[code-model] run'
        );
      }
    },
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function error(message: string, status: number): Response {
  return json({ error: { message, type: 'kyto_code_model_proxy' } }, status);
}

function addUsage({ token, usage }: { token: CodeModelToken; usage: Usage }) {
  token.totals.inputTokens += usage.inputTokens;
  token.totals.cachedTokens += usage.cachedTokens;
  token.totals.outputTokens += usage.outputTokens;
  token.totals.costUsd =
    usage.costUsd === undefined
      ? token.totals.costUsd
      : (token.totals.costUsd ?? 0) + usage.costUsd;
}

/**
 * Handle a request to the code-model proxy, or return null if the path isn't
 * ours (the caller falls through to the static sites).
 */
export async function handleCodeModelProxy({
  pathname,
  request,
  server,
}: {
  pathname: string;
  request: Request;
  server: { timeout: (request: Request, seconds: number) => void };
}): Promise<Response | null> {
  if (!pathname.startsWith(CODE_MODEL_PROXY_PREFIX)) {
    return null;
  }
  // Bun.serve drops a request after 10 idle seconds. A reasoning model streams
  // nothing while it thinks, so Bun cut the agent's stream mid-answer and it
  // failed with "stream transport error: INTERNAL_ERROR". The run's own minute
  // cap and the watchdog bound it instead.
  server.timeout(request, 0);
  const secret = (request.headers.get('authorization') ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  const token = secret ? tokens.get(secret) : undefined;
  if (token === undefined || Date.now() > token.expiry) {
    if (token !== undefined) {
      tokens.delete(secret);
    }
    return error('unauthorized', 401);
  }
  if (
    request.method !== 'POST' ||
    pathname.slice(CODE_MODEL_PROXY_PREFIX.length) !== CHAT_PATH
  ) {
    return error(`only POST /v1/${CHAT_PATH} is served here`, 404);
  }
  if (!(env.CODE_MODEL_BASE_URL && env.CODE_MODEL_API_KEY)) {
    return error('no code model is configured', 503);
  }
  if (token.calls >= CALL_BUDGET) {
    return error(
      `this run used its ${CALL_BUDGET} model calls; finish and report what is done`,
      429
    );
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return error('request too large', 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return error('body is not JSON', 400);
  }
  const body = chatBodySchema.safeParse(parsed);
  if (!body.success) {
    return error('body must be a chat completions request', 400);
  }
  const { model } = token;
  const down = modelDown(model);
  if (down) {
    return error(
      `the code model route is exhausted (${down.message}); retrying will fail the same way, so stop and report it`,
      400
    );
  }
  token.calls += 1;
  // "Why is the coding agent slow" had no answer: nothing said how many calls
  // a run made or how long each took upstream. One line per call, at its end.
  const call = token.calls;
  const startedAt = Date.now();
  const logCall = (fields: Record<string, unknown>) =>
    logger.info(
      {
        call,
        model,
        requestChars: raw.length,
        run: token.run,
        totalMs: Date.now() - startedAt,
        ...fields,
      },
      '[code-model] call'
    );
  const upstream = await fetch(
    `${env.CODE_MODEL_BASE_URL.replace(/\/+$/, '')}/${CHAT_PATH}`,
    {
      body: JSON.stringify({ ...body.data, model }),
      headers: {
        Authorization: `Bearer ${env.CODE_MODEL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: request.signal,
    }
  ).catch((fetchError: unknown) => {
    logCall({ error: String(fetchError) });
    throw fetchError;
  });
  const headersMs = Date.now() - startedAt;
  const contentType =
    upstream.headers.get('content-type') ?? 'application/json';
  if (!(upstream.ok && upstream.body)) {
    const text = await upstream.text().catch(() => '');
    const usage = usageSchema.safeParse(
      z.looseObject({ usage: z.unknown().optional() }).safeParse(safeJson(text))
        .data?.usage
    );
    const priced = usage.success
      ? priceUsage({ model, usage: usage.data })
      : undefined;
    if (priced) {
      addUsage({ token, usage: priced });
    }
    logCall({ headersMs, status: upstream.status, ...priced });
    noteRouteAnswer({ model, status: upstream.status, text });
    return new Response(text, {
      headers: { 'Content-Type': contentType },
      status: upstream.status,
    });
  }
  // The stream is re-emitted line by line so its events can be read: the
  // head for an error a router answers with a 200, the usage event for the
  // cost, and whether a finish_reason came at all — one router's Claude
  // stream never sends one, and the agent treats such a stream as failed and
  // retried the same call four times. One is added before [DONE].
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let head = '';
  let pending = '';
  let finished = false;
  let calledTools = false;
  let usage: Usage | undefined;
  const readEvent = (line: string) => {
    if (!line.startsWith('data: {')) {
      return;
    }
    const event = streamChunkSchema.safeParse(safeJson(line.slice(6)));
    if (!event.success) {
      return;
    }
    for (const choice of event.data.choices ?? []) {
      finished ||= Boolean(choice.finish_reason);
      calledTools ||= Boolean(choice.delta?.tool_calls);
    }
    if (event.data.usage) {
      usage = priceUsage({ model, usage: event.data.usage });
    }
  };
  const finishEvent = () =>
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {},
          finish_reason: calledTools ? 'tool_calls' : 'stop',
          index: 0,
        },
      ],
      object: 'chat.completion.chunk',
    })}\n\n`;
  const relayed = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush: (controller) => {
        if (pending) {
          controller.enqueue(encoder.encode(pending));
        }
        if (usage) {
          addUsage({ token, usage });
        }
        logCall({ headersMs, status: upstream.status, ...usage });
        if (/"error"/.test(head)) {
          noteRouteAnswer({ model, status: upstream.status, text: head });
        }
      },
      transform: (chunk, controller) => {
        const text = decoder.decode(chunk, { stream: true });
        if (head.length < SNIFF_CHARS) {
          head += text;
        }
        const lines = (pending + text).split('\n');
        pending = lines.pop() ?? '';
        let out = '';
        for (const line of lines) {
          if (line.trim() === 'data: [DONE]' && !finished) {
            finished = true;
            out += finishEvent();
          }
          readEvent(line);
          out += `${line}\n`;
        }
        if (out) {
          controller.enqueue(encoder.encode(out));
        }
      },
    })
  );
  return new Response(relayed, {
    headers: { 'Content-Type': contentType },
    status: upstream.status,
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}
