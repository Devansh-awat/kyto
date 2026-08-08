import { describe, expect, test } from 'bun:test';
import {
  COMPACT_BATCH,
  type CompactableMessage,
  MAX_MESSAGES_PER_PASS,
  planCompaction,
  renderCompactedBlock,
} from './compaction-plan';

function messages(count: number, offset = 0): CompactableMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${offset + index}`,
    rendered: `@someone: message ${offset + index}`,
  }));
}

/** Slack ids are timestamps, which is what the incremental fetch relies on. */
function timestamps(count: number, offset = 0): CompactableMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `17108186${String(offset + index).padStart(4, '0')}.000100`,
    rendered: `@someone: message ${offset + index}`,
  }));
}

describe('planCompaction', () => {
  test('does nothing when there is nothing earlier at all', () => {
    expect(planCompaction({ overflow: [] })).toBeUndefined();
  });

  test('summarizes everything the first time a thread overflows', () => {
    const plan = planCompaction({ overflow: messages(30) });
    expect(plan?.count).toBe(30);
    expect(plan?.passes).toHaveLength(1);
    expect(plan?.passes[0]).toHaveLength(30);
    expect(plan?.previous).toBeUndefined();
  });

  test('summarizes a first overflow even below the batch threshold', () => {
    // No stored summary means the thread has NEVER been compacted, so waiting
    // would leave the model with a bare count for the next 24 turns.
    expect(planCompaction({ overflow: messages(1) })?.passes).toHaveLength(1);
  });

  test('reuses the stored summary until enough new messages accumulate', () => {
    const plan = planCompaction({
      overflow: messages(COMPACT_BATCH + 5),
      stored: {
        coveredCount: 6,
        summary: 'earlier stuff',
        throughMessageId: 'm5',
      },
    });
    // 24 pending (m6..m29) is under the threshold.
    expect(plan?.passes).toEqual([]);
    expect(plan?.previous).toBe('earlier stuff');
    // The count still moves even though the digest does not.
    expect(plan?.count).toBe(30);
  });

  test('folds new messages into the stored summary once the batch fills', () => {
    const plan = planCompaction({
      overflow: messages(60),
      stored: {
        coveredCount: 10,
        summary: 'earlier stuff',
        throughMessageId: 'm9',
      },
    });
    expect(plan?.previous).toBe('earlier stuff');
    // Only m10..m59 — the already-covered prefix is not paid for twice.
    expect(plan?.passes[0]).toHaveLength(50);
    expect(plan?.passes[0]?.[0]?.id).toBe('m10');
  });

  test('counts what an earlier turn digested and never re-fetched', () => {
    // The whole point of the incremental fetch: `overflow` holds only the
    // messages since the last pass, so the block's count has to come from the
    // stored total plus those, not from what happens to be in hand.
    const plan = planCompaction({
      overflow: messages(30, 900),
      stored: {
        coveredCount: 900,
        summary: 'the first 900',
        throughMessageId: 'm899',
      },
    });
    expect(plan?.count).toBe(930);
  });

  test('ignores messages the digest already covers, by timestamp', () => {
    // conversations.replies prepends the thread ROOT to every page, so an
    // incremental read always hands back one message from before the boundary.
    const overflow = timestamps(40);
    const plan = planCompaction({
      overflow,
      stored: {
        coveredCount: 10,
        summary: 'earlier stuff',
        throughMessageId: overflow[9]?.id ?? '',
      },
    });
    expect(plan?.passes[0]).toHaveLength(30);
    expect(plan?.passes[0]?.[0]?.id).toBe(overflow[10]?.id);
    expect(plan?.count).toBe(40);
  });

  test('treats an unlocatable stored summary as covering nothing new', () => {
    // The thread changed underneath us. Folding into a digest whose starting
    // point we cannot find would double-count or skip a stretch.
    const plan = planCompaction({
      overflow: messages(40),
      stored: {
        coveredCount: 0,
        summary: 'stale',
        throughMessageId: 'not-in-this-thread',
      },
    });
    expect(plan?.passes[0]).toHaveLength(40);
  });

  test('splits a backlog into passes instead of dropping all but one', () => {
    // The old behaviour clamped to the newest MAX_MESSAGES_PER_PASS and moved
    // the marker past the rest, so a long-idle thread lost everything in
    // between — permanently, since the marker never went back.
    const total = MAX_MESSAGES_PER_PASS * 2 + 50;
    const plan = planCompaction({ overflow: messages(total) });
    expect(plan?.passes).toHaveLength(3);
    expect(plan?.passes.flat()).toHaveLength(total);
    expect(plan?.passes[0]?.[0]?.id).toBe('m0');
    expect(plan?.passes.at(-1)?.at(-1)?.id).toBe(`m${total - 1}`);
  });
});

describe('renderCompactedBlock', () => {
  test('always states the count, even with no summary', () => {
    const block = renderCompactedBlock({ count: 42 });
    expect(block).toContain('42 earlier message(s)');
    expect(block).toContain('<earlier_in_this_thread>');
    expect(block).toContain('</earlier_in_this_thread>');
  });

  test('does not claim a digest it does not have', () => {
    const block = renderCompactedBlock({ count: 5 });
    expect(block).not.toContain('compacted digest');
    expect(block).toContain('could not be summarized');
  });

  test('includes the summary and labels it as a digest', () => {
    const block = renderCompactedBlock({
      count: 5,
      summary: 'devansh asked for X; it was delivered',
    });
    expect(block).toContain('devansh asked for X');
    expect(block).toContain('compacted digest, not a transcript');
  });

  test('says how much of the history the digest does not cover yet', () => {
    const block = renderCompactedBlock({
      count: 1500,
      summary: 'the first 300',
      undigested: 1200,
    });
    expect(block).toContain('1500 earlier message(s)');
    expect(block).toContain('1200 most recent of those are not in the digest');
  });

  test('stays quiet about the gap when there is none', () => {
    const block = renderCompactedBlock({ count: 10, summary: 'all of it' });
    expect(block).not.toContain('not in the digest');
  });

  test('tells the model the replay is not the start of the conversation', () => {
    // The bug being fixed was the model treating the replay window as the whole
    // thread, so this sentence is load-bearing.
    expect(renderCompactedBlock({ count: 1 })).toContain(
      'do not treat the replayed history as its beginning'
    );
  });
});
