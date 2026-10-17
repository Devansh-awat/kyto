import { describe, expect, test } from 'bun:test';
import { withGhPrefixes } from './gh-prefix';

describe('withGhPrefixes', () => {
  test('a dropped leading gh is put back, after && and ; too (#80, #102)', () => {
    expect(withGhPrefixes('repo create o/r --public')).toBe(
      'gh repo create o/r --public'
    );
    expect(withGhPrefixes('gh api user && api user/repos')).toBe(
      'gh api user && gh api user/repos'
    );
    expect(withGhPrefixes('cd x; pr list || issue list')).toBe(
      'cd x; gh pr list || gh issue list'
    );
  });

  test('commands that already say gh, pipes and quoted text are left alone', () => {
    for (const command of [
      'gh pr list --repo o/r | grep foo',
      'gh pr create --title x --body "fix it; pr view later && api too"',
      "gh issue comment 3 --body 'done; repo create next'",
      'echo "say \\" ; api x" && gh status',
    ]) {
      expect(withGhPrefixes(command)).toBe(command);
    }
  });
});
