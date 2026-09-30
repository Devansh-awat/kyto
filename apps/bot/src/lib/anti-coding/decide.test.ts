import { describe, expect, test } from 'bun:test';
import { CODING_THRESHOLD, decideCodingAction } from './decide';

const CODING = 0.97;
const CHAT = 0.13;

describe('decideCodingAction', () => {
  test('lets through anything under the threshold', () => {
    expect(
      decideCodingAction({ probability: CHAT, usesOwnModels: false })
    ).toBe('allow');
    expect(
      decideCodingAction({
        probability: CODING_THRESHOLD - 0.01,
        usesOwnModels: false,
      })
    ).toBe('allow');
  });

  test('fails open when Jev could not answer', () => {
    expect(
      decideCodingAction({ probability: null, usesOwnModels: false })
    ).toBe('allow');
  });

  test('coding on the shared models goes to OpenCode — owner or not', () => {
    expect(
      decideCodingAction({ probability: CODING, usesOwnModels: false })
    ).toBe('delegate');
  });

  test('someone on their own key keeps coding on it', () => {
    expect(
      decideCodingAction({ probability: CODING, usesOwnModels: true })
    ).toBe('own-models-only');
  });
});
