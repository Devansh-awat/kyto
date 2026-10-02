import { describe, expect, test } from 'bun:test';
import { reactionName } from './harness';

describe('reactionName', () => {
  test('strips the colons models write around a name', () => {
    expect(reactionName(':+1:')).toBe('+1');
    expect(reactionName('::eyes::')).toBe('eyes');
    expect(reactionName(' white_check_mark ')).toBe('white_check_mark');
  });

  test('leaves a skin-tone name intact', () => {
    expect(reactionName(':wave::skin-tone-2:')).toBe('wave::skin-tone-2');
  });
});
