import { describe, expect, test } from 'bun:test';
import { clearTurn, setTurn, stopAllTurns } from '@/lib/agent/turns';
import type { ActiveTurn } from '@/types/agent';

describe('stopAllTurns', () => {
  test('aborts every turn and waits for them to clear', async () => {
    const turn: ActiveTurn = {
      controller: new AbortController(),
      pendingMessages: [],
    };
    setTurn({ threadId: 'slack:C1:1', turn });
    turn.controller.signal.addEventListener('abort', () => {
      setTimeout(() => clearTurn({ threadId: 'slack:C1:1', turn }), 50);
    });
    const started = Date.now();
    await stopAllTurns({ settleMs: 2000 });
    expect(turn.controller.signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('gives up after settleMs when a turn never clears', async () => {
    const turn: ActiveTurn = {
      controller: new AbortController(),
      pendingMessages: [],
    };
    setTurn({ threadId: 'slack:C2:1', turn });
    const started = Date.now();
    await stopAllTurns({ settleMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    clearTurn({ threadId: 'slack:C2:1', turn });
  });
});
