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
    expect(env.CODE_MODEL.split(',')).toContain(body.model);
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

  test('adds a missing finish_reason before [DONE] and keeps the stream', async () => {
    const events = [
      { choices: [{ delta: { tool_calls: [{ index: 0 }] }, index: 0 }] },
      { choices: [], usage: { completion_tokens: 10, prompt_tokens: 100 } },
    ];
    // Split mid-line, as a network read would.
    const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
    const cut = Math.floor(sse.length / 2);
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse.slice(0, cut)));
              controller.enqueue(new TextEncoder().encode(sse.slice(cut)));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      )) as unknown as typeof fetch;
    const run = registerCodeModelToken();
    const path = '/_codemodel/v1/chat/completions';
    const response = await handleCodeModelProxy({
      pathname: path,
      request: post(path, run.env.KYTO_CODE_MODEL_TOKEN ?? '', {
        messages: [],
        stream: true,
      }),
      server,
    });
    const text = (await response?.text()) ?? '';
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text.indexOf('tool_calls"')).toBeLessThan(text.indexOf('[DONE]'));
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(text).toContain('"prompt_tokens":100');
    run.revoke();
  });

  test('leaves a stream that has its finish_reason alone', async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\ndata: [DONE]\n\n`;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
      )) as unknown as typeof fetch;
    const run = registerCodeModelToken();
    const path = '/_codemodel/v1/chat/completions';
    const response = await handleCodeModelProxy({
      pathname: path,
      request: post(path, run.env.KYTO_CODE_MODEL_TOKEN ?? '', {
        messages: [],
        stream: true,
      }),
      server,
    });
    expect(await response?.text()).toBe(sse);
    run.revoke();
  });

  test('alternates runs between the configured models', async () => {
    const sent: string[] = [];
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).model);
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    const path = '/_codemodel/v1/chat/completions';
    for (let i = 0; i < 4; i++) {
      const run = registerCodeModelToken();
      await handleCodeModelProxy({
        pathname: path,
        request: post(path, run.env.KYTO_CODE_MODEL_TOKEN ?? '', {
          messages: [],
        }),
        server,
      });
      run.revoke();
    }
    expect(sent.toSorted()).toEqual([
      'r/claude-sonnet-5',
      'r/claude-sonnet-5',
      'r/glm-5.3',
      'r/glm-5.3',
    ]);
    expect(sent[0]).not.toBe(sent[1]);
  });

  // Last: it leaves both models marked down for the rest of the module.
  test('an exhausted model answers every later call at once (#154)', async () => {
    const sent: string[] = [];
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).model);
      return Promise.resolve(
        new Response(
          '{"error":{"message":"All credentials for model x are cooling down"}}',
          { headers: { 'content-type': 'application/json' }, status: 503 }
        )
      );
    }) as typeof fetch;
    const path = '/_codemodel/v1/chat/completions';
    const call = (secret: string) =>
      handleCodeModelProxy({
        pathname: path,
        request: post(path, secret, { messages: [] }),
        server,
      });
    const first = registerCodeModelToken();
    const firstSecret = first.env.KYTO_CODE_MODEL_TOKEN ?? '';
    expect((await call(firstSecret))?.status).toBe(503);
    // The other model is still up, so a run can start.
    expect(codeModelRouteDown()).toBeUndefined();
    expect((await call(firstSecret))?.status).toBe(400);
    expect(sent).toHaveLength(1);
    const second = registerCodeModelToken();
    expect((await call(second.env.KYTO_CODE_MODEL_TOKEN ?? ''))?.status).toBe(
      503
    );
    expect(new Set(sent).size).toBe(2);
    expect(codeModelRouteDown()?.message).toContain('cooling down');
    first.revoke();
    second.revoke();
  });
});
