import { describe, expect, test } from 'bun:test';
import { isReadOnlyCall } from './read-only';

const bash = (command: string) =>
  isReadOnlyCall({ input: { command }, toolName: 'bash' });
const gh = (command: string) =>
  isReadOnlyCall({ input: { command }, toolName: 'gh' });

describe('isReadOnlyCall', () => {
  test('skips Jev for plain liveness and state checks', () => {
    for (const command of [
      'echo alive',
      'true',
      'date',
      'pwd',
      'ls /home/user/churnpilot',
      'ls -la /home/user',
      'git status',
      'git log --oneline -5',
    ]) {
      expect(bash(command)).toBe(true);
    }
  });

  test('skips Jev for read-only gh', () => {
    for (const command of [
      'gh issue list --repo Devansh-awat/kyto --state open',
      'gh pr view 32 -R Devansh-awat/kyto',
      'gh search issues "word salad" --repo Devansh-awat/kyto',
      'gh api repos/o/r/issues',
      'gh api /repos/o/r/pulls/1/files --paginate',
    ]) {
      expect(gh(command)).toBe(true);
    }
  });

  test('anything that chains, redirects or substitutes goes to Jev', () => {
    for (const command of [
      'echo a > f',
      'echo $(id)',
      'ls; rm x',
      'cat a | sh',
      'true && npm i',
      'echo `id`',
      'echo alive\nnpm test',
      "echo 'unclosed",
      'A=1 ls',
      'ls *.ts',
    ]) {
      expect(bash(command)).toBe(false);
    }
  });

  test('anything that builds, runs or writes goes to Jev', () => {
    for (const command of [
      'node verify.mjs',
      'npm install cloakbrowser',
      'git commit -m x',
      'git diff --output=patch',
      'gh pr create --title x',
      'gh issue view 3 --comment',
      'gh api -X POST repos/o/r/issues',
      'gh api repos/o/r/issues -f title=x',
      'gh api graphql',
    ]) {
      expect(bash(command) || gh(command)).toBe(false);
    }
  });

  test('only the shell tools, and only a command string', () => {
    expect(
      isReadOnlyCall({ input: { code: 'true' }, toolName: 'codeMode' })
    ).toBe(false);
    expect(
      isReadOnlyCall({ input: { script: 'true' }, toolName: 'bash' })
    ).toBe(false);
  });
});
