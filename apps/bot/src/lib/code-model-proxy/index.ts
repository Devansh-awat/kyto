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

interface CodeModelToken {
  calls: number;
  expiry: number;
  /** Short id tying one run's call lines together in the log. */
  run: string;
}

// In-memory only: a restart ends every run anyway.
const tokens = new Map<string, CodeModelToken>();

// An exhausted route (the router's "All credentials … are cooling down", "Free
// usage limit reached", a 402) answers every retry the same way, and the agent
// retried it until its request timeout: 174s, then a blind `continue` retry
// cost another 108s, in a turn that delivered nothing (#154). The first such
// answer marks the route down; until then every call gets a 400 at once — a
// status the agent does not retry — and the tool refuses to start a run.
const ROUTE_DOWN_MS = 10 * 60 * 1000;
// A bare 429 with no quota wording is more likely a per-minute limit.
const RATE_LIMITED_MS = 60 * 1000;
const QUOTA_TEXT =
  /cooling down|usage limit|quota|insufficient[ _-]?(?:credits|balance|funds)|subscribe to|payment required/i;
// Only the head of a streamed body is read for an error event.
const SNIFF_CHARS = 4000;

let routeDown: { message: string; until: number } | undefined;

/** The coding model's route, when the last answer said it is exhausted. */
export function codeModelRouteDown():
  | { message: string; until: number }
  | undefined {
  if (routeDown && Date.now() > routeDown.until) {
    routeDown = undefined;
  }
  return routeDown;
}

function noteRouteAnswer({ status, text }: { status: number; text: string }) {
  const quota = status === 402 || QUOTA_TEXT.test(text);
  if (quota || status === 429) {
    routeDown = {
      message:
        text.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${status}`,
      until: Date.now() + (quota ? ROUTE_DOWN_MS : RATE_LIMITED_MS),
    };
    logger.warn({ status, text: routeDown.message }, '[code-model] route down');
  }
}

const chatBodySchema = z.looseObject({ messages: z.array(z.unknown()) });

// Crush asks its small model for a session title before every run. On the
// coding route that streamed call came back empty, the router locked the
// route's one account for a few seconds, and the run's real call landing in
// that window failed with "No active credentials for provider". Nobody reads
// the title, so it is answered here and never reaches the model.
const TITLE_PROMPT_START = 'You will generate a short title';
const TITLE = 'Coding task';
const titleRequestSchema = z.looseObject({
  messages: z.tuple(
    [
      z.looseObject({
        content: z.string().startsWith(TITLE_PROMPT_START),
        role: z.literal('system'),
      }),
    ],
    z.unknown()
  ),
  stream: z.boolean().optional(),
});

function titleAnswer(stream: boolean): Response {
  const base = {
    created: Math.floor(Date.now() / 1000),
    id: 'kyto-title',
    model: 'kyto-code',
  };
  if (!stream) {
    return json(
      {
        ...base,
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: { content: TITLE, role: 'assistant' },
          },
        ],
        object: 'chat.completion',
      },
      200
    );
  }
  const chunk = (choice: Record<string, unknown>) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, ...choice }], object: 'chat.completion.chunk' })}\n\n`;
  return new Response(
    `${chunk({ delta: { content: TITLE, role: 'assistant' }, finish_reason: null })}${chunk({ delta: {}, finish_reason: 'stop' })}data: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }
  );
}

/** Whether the coding agent has a model to run on. */
export function codeModelConfigured(): boolean {
  return Boolean(
    env.SITES_ENABLED && env.CODE_MODEL_BASE_URL && env.CODE_MODEL_API_KEY
  );
}

/** Mint one run's secret and the env that points the agent at this proxy. */
export function registerCodeModelToken(): {
  env: Record<string, string>;
  revoke: () => void;
} {
  const secret = randomBytes(24).toString('base64url');
  tokens.set(secret, {
    calls: 0,
    expiry: Date.now() + TOKEN_TTL_MS,
    run: randomBytes(4).toString('hex'),
  });
  return {
    env: {
      KYTO_CODE_MODEL_TOKEN: secret,
      KYTO_CODE_MODEL_URL: `https://${env.SITES_PUBLIC_HOST}/_codemodel/v1`,
    },
    revoke: () => tokens.delete(secret),
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
  // nothing while it thinks, so Bun cut the agent's stream mid-answer and Crush
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
  const title = titleRequestSchema.safeParse(body.data);
  if (title.success) {
    return titleAnswer(title.data.stream ?? false);
  }
  const down = codeModelRouteDown();
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
      body: JSON.stringify({ ...body.data, model: env.CODE_MODEL }),
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
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    logCall({ headersMs, status: upstream.status });
    noteRouteAnswer({ status: upstream.status, text });
    return new Response(text, {
      headers: {
        'Content-Type':
          upstream.headers.get('content-type') ?? 'application/json',
      },
      status: upstream.status,
    });
  }
  if (!upstream.body) {
    logCall({ headersMs, status: upstream.status });
  }
  // A router can also answer 200 and put the quota error in the stream's
  // first event, so the head of the body is checked too.
  const decoder = new TextDecoder();
  let head = '';
  const timed = upstream.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush: () => {
        logCall({ headersMs, status: upstream.status });
        if (/"error"/.test(head)) {
          noteRouteAnswer({ status: upstream.status, text: head });
        }
      },
      transform: (chunk, controller) => {
        if (head.length < SNIFF_CHARS) {
          head += decoder.decode(chunk, { stream: true });
        }
        controller.enqueue(chunk);
      },
    })
  );
  return new Response(timed ?? null, {
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/json',
    },
    status: upstream.status,
  });
}
