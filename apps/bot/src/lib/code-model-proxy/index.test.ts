import { afterEach, describe, expect, test } from 'bun:test';
import { env } from '@/env';
import {
  codeModelRouteDown,
  handleCodeModelProxy,
  registerCodeModelToken,
} from './index';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const server = { timeout: () => undefined };

function post(path: string, secret: string, body: unknown): Request {
  return new Request(`https://host${path}`, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${secret}` },
    method: 'POST',
  });
}

describe('code-model proxy', () => {
  test('ignores paths that are not its own', async () => {
    const request = new Request('https://host/site/page');
    expect(
      await handleCodeModelProxy({ pathname: '/site/page', request, server })
    ).toBeNull();
  });

  test('turns off the idle timeout for its own requests', async () => {
    const timeouts: number[] = [];
    const path = '/_codemodel/v1/chat/completions';
    await handleCodeModelProxy({
      pathname: path,
      request: post(path, 'nope', { messages: [] }),
      server: { timeout: (_request, seconds) => timeouts.push(seconds) },
    });
    expect(timeouts).toEqual([0]);
  });

  test('refuses an unknown or revoked secret', async () => {
    const run = registerCodeModelToken();
    const secret = run.env.KYTO_CODE_MODEL_TOKEN ?? '';
    run.revoke();
    const path = '/_codemodel/v1/chat/completions';
    const response = await handleCodeModelProxy({
      pathname: path,
      request: post(path, secret, { messages: [] }),
      server,
    });
    expect(response?.status).toBe(401);
  });

  test('serves only chat completions', async () => {
    const run = registerCodeModelToken();
    const path = '/_codemodel/v1/embeddings';
    const response = await handleCodeModelProxy({
      pathname: path,
      request: post(path, run.env.KYTO_CODE_MODEL_TOKEN ?? '', {
        messages: [],
      }),
      server,
    });
    expect(response?.status).toBe(404);
    run.revoke();
  });

  test('forces the model and adds the real key on the host', async () => {
    let sent: { auth: string | null; body: string; url: string } | undefined;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      sent = {
        auth: new Headers(init.headers).get('authorization'),
        body: String(init.body),
        url,
      };
      return Promise.resolve(
        new Response('{"ok":true}', {
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch;
    const run = registerCodeModelToken();
    const path = '/_codemodel/v1/chat/completions';
    const response = await handleCodeModelProxy({
      pathname: path,
      request: post(path, run.env.KYTO_CODE_MODEL_TOKEN ?? '', {
        messages: [{ content: 'hi', role: 'user' }],
        model: 'claude-opus-5-5',
        stream: true,
      }),
      server,
    });
    expect(response?.status).toBe(200);
    expect(sent?.url).toBe(`${env.CODE_MODEL_BASE_URL}/chat/completions`);
    expect(sent?.auth).toBe(`Bearer ${env.CODE_MODEL_API_KEY}`);
    const body = JSON.parse(sent?.body ?? '{}');
    expect(body.model).toBe(env.CODE_MODEL);
    expect(body.stream).toBe(true);
    run.revoke();
  });

  test('rejects a body that is not a chat request', async () => {
    const run = registerCodeModelToken();
    const path = '/_codemodel/v1/chat/completions';
    const response = await handleCodeModelProxy({
      pathname: path,
      request: post(path, run.env.KYTO_CODE_MODEL_TOKEN ?? '', { prompt: 'x' }),
      server,
    });
    expect(response?.status).toBe(400);
    run.revoke();
  });

  test("answers Crush's title request without calling the model", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (() => {
      upstreamCalls += 1;
      return Promise.resolve(new Response('{}'));
    }) as unknown as typeof fetch;
    const run = registerCodeModelToken();
    const path = '/_codemodel/v1/chat/completions';
    const secret = run.env.KYTO_CODE_MODEL_TOKEN ?? '';
    const messages = [
      {
        content: 'You will generate a short title based on the first message.',
        role: 'system',
      },
      { content: 'Generate a concise title for: fix the bug', role: 'user' },
    ];
    const streamed = await handleCodeModelProxy({
      pathname: path,
      request: post(path, secret, { messages, stream: true }),
      server,
    });
    const events = await streamed?.text();
    expect(events).toContain('"content":"Coding task"');
    expect(events).toContain('"finish_reason":"stop"');
    expect(events?.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const plain = await handleCodeModelProxy({
      pathname: path,
      request: post(path, secret, { messages }),
      server,
    });
    expect(await plain?.text()).toContain('"content":"Coding task"');
    expect(upstreamCalls).toBe(0);
    run.revoke();
  });

  // Last: it leaves the route marked down for the rest of the module.
  test('an exhausted route answers every later call at once (#154)', async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (() => {
      upstreamCalls += 1;
      return Promise.resolve(
        new Response(
          '{"error":{"message":"All credentials for model x are cooling down"}}',
          { headers: { 'content-type': 'application/json' }, status: 503 }
        )
      );
    }) as unknown as typeof fetch;
    const run = registerCodeModelToken();
    const path = '/_codemodel/v1/chat/completions';
    const secret = run.env.KYTO_CODE_MODEL_TOKEN ?? '';
    const first = await handleCodeModelProxy({
      pathname: path,
      request: post(path, secret, { messages: [] }),
      server,
    });
    expect(first?.status).toBe(503);
    expect(codeModelRouteDown()?.message).toContain('cooling down');
    const retry = await handleCodeModelProxy({
      pathname: path,
      request: post(path, secret, { messages: [] }),
      server,
    });
    expect(retry?.status).toBe(400);
    expect(upstreamCalls).toBe(1);
    run.revoke();
  });
});
