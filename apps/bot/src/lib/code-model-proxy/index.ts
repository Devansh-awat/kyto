import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/env';

// The model endpoint of the sandbox coding agent (the `opencode` tool). The
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
}

// In-memory only: a restart ends every run anyway.
const tokens = new Map<string, CodeModelToken>();

const chatBodySchema = z.looseObject({ messages: z.array(z.unknown()) });

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
  tokens.set(secret, { calls: 0, expiry: Date.now() + TOKEN_TTL_MS });
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
export async function handleCodeModelProxy(
  request: Request,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith(CODE_MODEL_PROXY_PREFIX)) {
    return null;
  }
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
  token.calls += 1;
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
  );
  return new Response(upstream.body, {
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/json',
    },
    status: upstream.status,
  });
}
