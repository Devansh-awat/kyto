import { describe, expect, test } from 'bun:test';
import type { ModelAttempt } from '@repo/ai';
import { createAttemptRouter } from '@/lib/agent/attempt-router';
import { attemptKey } from '@/lib/agent/routing';

const attempt = (provider: string, model: string): ModelAttempt => ({
  apiKey: 'k',
  baseURL: `https://${provider}.example/v1`,
  model,
  provider,
});
const primary = attempt('hackclub', 'luna');
const glm = attempt('hackclub', 'glm');
const gemini = attempt('gemini', 'flash');
const own = attempt('byok', 'mine');
const strong = attempt('hackclub', 'kimi');

const router = (
  overrides: Partial<Parameters<typeof createAttemptRouter>[0]> = {}
) =>
  createAttemptRouter({
    cached: { providers: [], rungs: [] },
    fallback: [glm, gemini],
    hackclubProvider: 'hackclub',
    ownModelsOnly: () => false,
    primary,
    routing: { own: [], ownFirst: false, serviceFallback: true },
    lead: undefined,
    ...overrides,
  });

describe('createAttemptRouter', () => {
  test('primary first, then the fallback queue, skipping what failed', () => {
    const walk = router();
    const first = walk.next();
    expect(first?.model).toBe('luna');
    if (first) {
      walk.markFailed(first);
    }
    expect(walk.next()?.model).toBe('glm');
  });

  test('a spend limit writes off every Hack Club rung', () => {
    const walk = router();
    walk.next();
    walk.markSpendLimit('daily limit reached');
    expect(walk.next()?.model).toBe('flash');
    expect(walk.budgetExhausted).toBe(true);
    expect(walk.spendLimitMessage).toBe('daily limit reached');
  });

  test('one proxy failure marks Hack Club down', () => {
    const walk = router();
    walk.next();
    walk.markHackclubFailure();
    expect(walk.next()?.provider).toBe('gemini');
  });

  test('a sticky upgrade leads, then the primary', () => {
    const walk = router({ lead: strong });
    const first = walk.next();
    expect(first?.model).toBe('kimi');
    if (first) {
      walk.markFailed(first);
    }
    expect(walk.next()?.model).toBe('luna');
  });

  test('own-first stops after own attempts unless the shared chain is opted into', () => {
    const closed = router({
      routing: { own: [own], ownFirst: true, serviceFallback: false },
    });
    expect(closed.next()?.model).toBe('mine');
    expect(closed.next()).toBeUndefined();
    const open = router({
      routing: { own: [own], ownFirst: true, serviceFallback: true },
    });
    open.next();
    expect(open.next()?.model).toBe('luna');
  });

  test('shared-first uses own attempts as the last resort', () => {
    const walk = router({
      cached: { providers: ['hackclub'], rungs: [attemptKey(gemini)] },
      routing: { own: [own], ownFirst: false, serviceFallback: true },
    });
    expect(walk.next()?.model).toBe('mine');
  });

  test('coding work on an own key never reaches the shared chain', () => {
    const walk = router({
      ownModelsOnly: () => true,
      routing: { own: [own], ownFirst: false, serviceFallback: true },
    });
    expect(walk.next()?.model).toBe('mine');
    expect(walk.next()).toBeUndefined();
  });

  test('resetting cached deadness walks from the top again', () => {
    const walk = router({ cached: { providers: ['hackclub'], rungs: [] } });
    expect(walk.next()?.provider).toBe('gemini');
    walk.resetCachedDeadness();
    expect(walk.next()?.model).toBe('luna');
  });
});
