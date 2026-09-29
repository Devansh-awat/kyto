import { describe, expect, test } from 'bun:test';
import {
  CODING_THRESHOLD,
  decideCodingAction,
  isBanStrike,
  WARNINGS_BEFORE_BAN,
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

describe('isBanStrike', () => {
  test('the first three catches are warnings', () => {
    for (let count = 1; count <= WARNINGS_BEFORE_BAN; count += 1) {
      expect(isBanStrike(count)).toBe(false);
    }
  });

  test('the fourth catch bans, and so does every one after it in the run', () => {
    expect(isBanStrike(WARNINGS_BEFORE_BAN + 1)).toBe(true);
    expect(isBanStrike(WARNINGS_BEFORE_BAN + 5)).toBe(true);
  });
});
