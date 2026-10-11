import { describe, expect, test } from 'bun:test';
import { parseGithubCommand } from './command';

describe('parseGithubCommand', () => {
  test('reads are not mutating', () => {
    for (const command of [
      'gh pr list --repo owner/name',
      'gh pr view 12 --repo owner/name | grep title',
      'gh repo clone owner/name',
      "gh api repos/owner/name/issues --jq '.[].title'",
      'gh search repos kyto',
      'git clone https://github.com/owner/name.git && cd name && git log',
    ]) {
      expect(parseGithubCommand(command).mutating).toBe(false);
    }
  });

  test('writes are caught with their target repo', () => {
    const cases: [string, string][] = [
      ['gh pr close 12 --repo Owner/Name', 'owner/name'],
      ['gh issue comment 3 -R owner/name --body hi', 'owner/name'],
      ['gh repo delete owner/name --yes', 'owner/name'],
      ['gh api -X DELETE repos/owner/name/issues/1', 'owner/name'],
      ['git push https://github.com/owner/name.git main', 'owner/name'],
      [
        "curl -X POST -d '{}' https://api.github.com/repos/owner/name/issues",
        'owner/name',
      ],
    ];
    for (const [command, repo] of cases) {
      const parsed = parseGithubCommand(command);
      expect(parsed.mutating).toBe(true);
      expect(parsed.repos).toContain(repo);
    }
  });

  test('an unknown gh subcommand counts as a write', () => {
    expect(parseGithubCommand('gh pr frobnicate --repo o/n').mutating).toBe(
      true
    );
  });

  test('a wrapped or quoted invocation is still seen', () => {
    const wrapped = parseGithubCommand(
      `sh -c "gh pr close 4 --repo owner/name"`
    );
    expect(wrapped.mutating).toBe(true);
    expect(wrapped.repos).toContain('owner/name');

    const script = parseGithubCommand(
      `await sh('gh pr merge 9 --repo owner/name');`
    );
    expect(script.mutating).toBe(true);
    expect(script.repos).toContain('owner/name');
  });

  test('a bare push needs the checkout remote to resolve', () => {
    const parsed = parseGithubCommand('git push origin main');
    expect(parsed.mutating).toBe(true);
    expect(parsed.needsRemote).toBe(true);
    expect(parsed.repos).toHaveLength(0);
  });

  test('repo creation is recorded so it can be claimed', () => {
    const parsed = parseGithubCommand(
      'gh repo create kyto-agent/thing --public'
    );
    expect(parsed.creates).toEqual(['kyto-agent/thing']);
    expect(parsed.repos).toContain('kyto-agent/thing');
  });
});

describe('git global flags', () => {
  // `-C <dir>` takes a separate value, and the old scan took that value as the
  // subcommand — so `git -C /repo push` read as verb "/repo" and was not
  // flagged as mutating at all.
  test('sees the verb past a flag that consumes its value', () => {
    expect(parseGithubCommand('git -C /repo push').mutating).toBe(true);
    expect(
      parseGithubCommand('git -c user.name=x -C /repo push').mutating
    ).toBe(true);
    expect(
      parseGithubCommand('git --git-dir /repo/.git push origin main').mutating
    ).toBe(true);
  });

  test('still ignores a read-only verb behind the same flags', () => {
    expect(parseGithubCommand('git -C /repo status').mutating).toBe(false);
  });
});

describe('contribution and push-only commands', () => {
  test('gh pr/issue create and comment are contributions', () => {
    for (const command of [
      'gh pr create --repo o/r --title x --body y',
      'gh issue create -R o/r --title x',
      'gh pr comment 3 --repo o/r --body ok',
    ]) {
      expect(parseGithubCommand(command)).toMatchObject({
        contribution: true,
        pushOnly: false,
      });
    }
  });

  test('anything else in the same command stops it being one', () => {
    for (const command of [
      'gh pr create --repo o/r && gh pr merge 3 --repo o/r',
      'gh pr comment 3 --repo o/r --edit-last --body y',
      'gh pr create --repo o/r; git push origin main',
    ]) {
      expect(parseGithubCommand(command).contribution).toBe(false);
    }
  });

  test('a lone push is push-only', () => {
    expect(parseGithubCommand('git push -u origin u1/fix')).toMatchObject({
      contribution: false,
      pushOnly: true,
    });
    expect(parseGithubCommand('gh repo list').pushOnly).toBe(false);
  });
});
