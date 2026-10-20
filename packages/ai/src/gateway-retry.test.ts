import { describe, expect, test } from 'bun:test';
import { fetchWithGatewayRetry, isReplayableRequest } from './gateway-retry';

// A fetch stand-in that hands back the given statuses in order and records how
// many times it was called. 200s carry a body so a cancelled body is observable.
function fakeFetch(statuses: number[]) {
  const calls: { body: unknown; url: string }[] = [];
  const send = (input: string | URL | Request, init?: RequestInit) => {
    const status = statuses[calls.length] ?? 200;
    calls.push({ body: init?.body, url: String(input) });
    return Promise.resolve(new Response(`body-${status}`, { status }));
  };
  return { calls, send };
}

const noSleep = () => Promise.resolve();

describe('fetchWithGatewayRetry', () => {
  test('returns a good response without retrying', async () => {
    const { calls, send } = fakeFetch([200]);
    const response = await fetchWithGatewayRetry(
      'https://proxy/v1',
      undefined,
      {
        fetchImpl: send,
        sleep: noSleep,
      }
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test('replays a 504 and returns the send that succeeds', async () => {
    const { calls, send } = fakeFetch([504, 200]);
    const retries: number[] = [];
    const response = await fetchWithGatewayRetry(
      'https://proxy/v1',
      { body: '{"model":"kimi"}' },
      {
        fetchImpl: send,
        onRetry: (info) => retries.push(info.status),
        sleep: noSleep,
      }
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    // The replay is byte-identical — a retried step must not change the request.
    expect(calls[1]?.body).toBe('{"model":"kimi"}');
    expect(retries).toEqual([504]);
  });

  test('gives up after two retries and returns the failure', async () => {
    const { calls, send } = fakeFetch([504, 504, 504, 200]);
    const response = await fetchWithGatewayRetry(
      'https://proxy/v1',
      undefined,
      {
        fetchImpl: send,
        sleep: noSleep,
      }
    );
    // Exhausted looks exactly like the single failure the caller used to get,
    // so the fallback walk still runs on a proxy that is genuinely down.
    expect(response.status).toBe(504);
    expect(calls).toHaveLength(3);
  });

  test('does not retry a model-side failure', async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const { calls, send } = fakeFetch([status, 200]);
      const response = await fetchWithGatewayRetry(
        'https://proxy/v1',
        undefined,
        { fetchImpl: send, sleep: noSleep }
      );
      expect(response.status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  test('stops retrying once the turn is aborted', async () => {
    const { calls, send } = fakeFetch([504, 504, 200]);
    const controller = new AbortController();
    controller.abort();
    const response = await fetchWithGatewayRetry(
      'https://proxy/v1',
      { signal: controller.signal },
      { fetchImpl: send, sleep: noSleep }
    );
    expect(response.status).toBe(504);
    expect(calls).toHaveLength(1);
  });

  test('sends a non-replayable request exactly once', async () => {
    const { calls, send } = fakeFetch([504, 200]);
    const request = new Request('https://proxy/v1', {
      body: '{"model":"kimi"}',
      method: 'POST',
    });
    const response = await fetchWithGatewayRetry(request, undefined, {
      fetchImpl: send,
      sleep: noSleep,
    });
    expect(response.status).toBe(504);
    expect(calls).toHaveLength(1);
  });
});

const POOL_LIMIT =
  '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"inception/mercury-3 is temporarily rate-limited upstream. Please retry shortly","limit_source":"upstream_provider_shared_pool"}}}';

// Hands back the given [status, body] pairs in order, then 200s.
function bodiesFetch(replies: [number, string][]) {
  let count = 0;
  const send = () => {
    const [status, body] = replies[count] ?? [200, 'ok'];
    count += 1;
    return Promise.resolve(new Response(body, { status }));
  };
  return { calls: () => count, send };
}

describe('shared-pool 429s', () => {
  test('replays an upstream pool 429 until it clears', async () => {
    const { calls, send } = bodiesFetch([
      [429, POOL_LIMIT],
      [429, POOL_LIMIT],
    ]);
    const retries: boolean[] = [];
    const response = await fetchWithGatewayRetry(
      'https://proxy/v1',
      undefined,
      {
        fetchImpl: send,
        onRetry: (info) => retries.push(info.rateLimited === true),
        sleep: noSleep,
      }
    );
    expect(response.status).toBe(200);
    expect(calls()).toBe(3);
    expect(retries).toEqual([true, true]);
  });

  test('gives up after three and hands the 429 back, body intact', async () => {
    const { calls, send } = bodiesFetch(
      Array.from({ length: 5 }, (): [number, string] => [429, POOL_LIMIT])
    );
    const response = await fetchWithGatewayRetry(
      'https://proxy/v1',
      undefined,
      {
        fetchImpl: send,
        sleep: noSleep,
      }
    );
    expect(response.status).toBe(429);
    expect(calls()).toBe(4);
    // The fallback classifier still reads the error body.
    expect(await response.text()).toContain('rate-limited upstream');
  });

  test('never replays a 429 that says the budget is spent', async () => {
    const { calls, send } = bodiesFetch([
      [429, '{"error":{"message":"daily spend limit reached"}}'],
    ]);
    const response = await fetchWithGatewayRetry(
      'https://proxy/v1',
      undefined,
      {
        fetchImpl: send,
        sleep: noSleep,
      }
    );
    expect(response.status).toBe(429);
    expect(calls()).toBe(1);
  });
});

describe('isReplayableRequest', () => {
  test('accepts the shape the AI SDK actually sends', () => {
    expect(isReplayableRequest('https://proxy/v1', { body: '{}' })).toBe(true);
    expect(
      isReplayableRequest('https://proxy/v1', {
        body: new TextEncoder().encode('{}'),
      })
    ).toBe(true);
    expect(isReplayableRequest('https://proxy/v1', undefined)).toBe(true);
  });

  test('rejects a body we cannot hold on to', () => {
    // fetch(Request) consumes the stream; a replay would send an empty body.
    expect(
      isReplayableRequest(new Request('https://proxy/v1'), undefined)
    ).toBe(false);
    expect(
      isReplayableRequest('https://proxy/v1', {
        body: new ReadableStream() as unknown as RequestInit['body'],
      })
    ).toBe(false);
  });
});
