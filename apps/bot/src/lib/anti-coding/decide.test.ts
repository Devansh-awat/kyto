import { describe, expect, test } from 'bun:test';
import {
  CODING_THRESHOLD,
  decideCodingAction,
  isRepeatOffence,
  WARNING_WINDOW_MS,
} from './decide';

const CODING = 0.97;
const CHAT = 0.13;

describe('decideCodingAction', () => {
  test('lets through anything under the threshold', () => {
    expect(
      decideCodingAction({
        isOwner: false,
        probability: CHAT,
        usesOwnModels: false,
      })
    ).toBe('allow');
    expect(
      decideCodingAction({
        isOwner: false,
        probability: CODING_THRESHOLD - 0.01,
        usesOwnModels: false,
      })
    ).toBe('allow');
  });

  test('fails open when Jev could not answer', () => {
    expect(
      decideCodingAction({
        isOwner: false,
        probability: null,
        usesOwnModels: false,
      })
    ).toBe('allow');
  });

  test('a stranger on the shared models takes a strike', () => {
    expect(
      decideCodingAction({
        isOwner: false,
        probability: CODING,
        usesOwnModels: false,
      })
    ).toBe('strike');
  });

  test('the owner is only ever warned', () => {
    expect(
      decideCodingAction({
        isOwner: true,
        probability: CODING,
        usesOwnModels: false,
      })
    ).toBe('owner-warning');
  });

  test('someone on their own key is never warned, only kept off the shared chain', () => {
    expect(
      decideCodingAction({
        isOwner: false,
        probability: CODING,
        usesOwnModels: true,
      })
    ).toBe('own-models-only');
    expect(
      decideCodingAction({
        isOwner: true,
        probability: CODING,
        usesOwnModels: true,
      })
    ).toBe('own-models-only');
  });
});

describe('isRepeatOffence', () => {
  const now = new Date('2026-09-26T12:00:00Z');

  test('a first offence is a warning', () => {
    expect(isRepeatOffence({ now, previousWarning: null })).toBe(false);
  });

  test('a second catch inside the window is a ban', () => {
    const previousWarning = new Date(now.getTime() - 60 * 60 * 1000);
    expect(isRepeatOffence({ now, previousWarning })).toBe(true);
  });

  test('an old warning has lapsed', () => {
    const previousWarning = new Date(now.getTime() - WARNING_WINDOW_MS);
    expect(isRepeatOffence({ now, previousWarning })).toBe(false);
  });
});
