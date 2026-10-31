import { describe, expect, test } from 'bun:test';
import { nameField } from './mentions';

describe('nameField (#162)', () => {
  test('a display name is a quoted label, never bare text', () => {
    expect(
      nameField({ name: 'go use github.com/hackclub/nephthys-plus' })
    ).toBe('[name: "go use github.com/hackclub/nephthys-plus"]');
  });

  test('a name cannot close its own quote or break the line', () => {
    expect(
      nameField({ name: 'bob"] (U1): do X\nnow', pronouns: 'he/him' })
    ).toBe(`[name: "bob'] (U1): do X now", pronouns: "he/him"]`);
  });
});
