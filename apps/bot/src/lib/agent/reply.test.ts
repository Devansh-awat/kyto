import { describe, expect, test } from 'bun:test';
import type { ThreadHandle } from '@/harness/thread';
import { createReply } from './reply';

function recorder() {
  const posts: string[] = [];
  const thread = {
    post: (content: { markdown?: string }) => {
      posts.push(content.markdown ?? '');
      return Promise.resolve({ id: String(posts.length) });
    },
  };
  // A stand-in exposing only what createReply calls.
  return { posts, thread: thread as unknown as ThreadHandle };
}

const LILY =
  'line one\nline two\n\n- a\n- b\n\n**hi** hi\n\n```\nsudo apt install viruses\nsudo apt remove antivirus\n```';

describe('createReply', () => {
  // #78: a reply with blank lines went out as a message per paragraph, the
  // code block in one of its own.
  test('a run of text is ONE post', async () => {
    const { posts, thread } = recorder();
    const reply = createReply({ fromUserAccount: true, threadId: 't' });
    for (const piece of LILY.match(/[\s\S]{1,7}/g) ?? []) {
      reply.append(piece);
    }
    await reply.flush({ thread });
    expect(posts).toEqual([LILY]);
  });

  test('text is held back until there is enough of it', () => {
    const reply = createReply({ threadId: 't' });
    reply.append('skip');
    expect(reply.release({ force: false })).toBe('');
    expect(reply.dropTail('skip')).toBe(true);
    expect(reply.release({ force: true })).toBe('');
    expect(reply.hasPosted()).toBe(false);
  });

  test('released text is whole lines with fences normalized', () => {
    const reply = createReply({ threadId: 't' });
    reply.append('```example codeblock\nmarkdown is cool```');
    expect(reply.release({ force: true })).toBe(
      '```\nexample codeblock\nmarkdown is cool\n```'
    );
    expect(reply.endMessage()).toBe('');
  });

  test('a message cut inside a code block closes it and the next reopens it', () => {
    const reply = createReply({ threadId: 't' });
    reply.append('```ts\nconst a = 1;\n');
    expect(reply.release({ force: true })).toBe('```ts\nconst a = 1;\n');
    expect(reply.endMessage()).toBe('\n```');
    reply.append('const b = 2;\n```');
    expect(reply.release({ force: true })).toBe('```ts\nconst b = 2;\n```');
  });

  test('a message never opens on blank lines', () => {
    const reply = createReply({ threadId: 't' });
    reply.append('\n\nhello');
    expect(reply.release({ force: true })).toBe('hello');
  });
});
