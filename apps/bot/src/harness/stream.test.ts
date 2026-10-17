import { describe, expect, spyOn, test } from 'bun:test';
import { createLogger } from '@repo/logging/logger';
import { SlackHarness } from './harness';

const logger = await createLogger({ isProduction: true, logLevel: 'error' });

// Slack's side of a streamed message: refuses one that would pass `limit`.
function fakeSlack({ limit }: { limit: number }) {
  const harness = new SlackHarness({ botToken: 'xoxb-test', logger });
  const messages = new Map<string, string>();
  let next = 0;
  const add = (ts: string, chunks: unknown) => {
    const text = (Array.isArray(chunks) ? chunks : [])
      .map((chunk: { text?: string }) => chunk.text ?? '')
      .join('');
    const total = (messages.get(ts) ?? '') + text;
    if (total.length > limit) {
      throw new Error('An API error occurred: msg_too_long');
    }
    messages.set(ts, total);
  };
  spyOn(harness.webClient.chat, 'startStream').mockImplementation((args) => {
    next += 1;
    const ts = `${next}.000`;
    add(ts, 'chunks' in args ? args.chunks : undefined);
    return Promise.resolve({ ok: true, ts });
  });
  spyOn(harness.webClient.chat, 'appendStream').mockImplementation((args) => {
    add(args.ts, 'chunks' in args ? args.chunks : undefined);
    return Promise.resolve({ ok: true });
  });
  spyOn(harness.webClient.chat, 'stopStream').mockImplementation((args) => {
    add(args.ts, 'chunks' in args ? args.chunks : undefined);
    return Promise.resolve({ ok: true });
  });
  spyOn(harness.webClient, 'apiCall').mockResolvedValue({ ok: true });
  return { harness, messages };
}

async function* from(parts: string[]): AsyncGenerator<string> {
  for await (const part of parts) {
    yield part;
  }
}

const stream = (harness: SlackHarness, parts: string[]) =>
  harness.stream('slack:C1:1.000', from(parts), {
    recipientTeamId: 'T1',
    recipientUserId: 'U1',
  });

describe('streamed reply text', () => {
  test('one long run with no line break is spread over messages (#106)', async () => {
    const { harness, messages } = fakeSlack({ limit: 12_000 });
    const text = 'word '.repeat(6600);
    const posted = await stream(harness, [text]);
    expect(posted.length).toBeGreaterThanOrEqual(3);
    expect([...messages.values()].join('')).toBe(text);
    for (const body of messages.values()) {
      expect(body.length).toBeLessThanOrEqual(12_000);
    }
  });

  test('a message Slack calls full continues in a new one, nothing lost', async () => {
    const { harness, messages } = fakeSlack({ limit: 5000 });
    const parts = Array.from(
      { length: 40 },
      (_, index) => `line ${index} ${'x'.repeat(290)}\n`
    );
    await stream(harness, parts);
    expect(messages.size).toBeGreaterThan(1);
    expect([...messages.values()].join('')).toBe(parts.join(''));
  });
});
