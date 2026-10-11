import { describe, expect, test } from 'bun:test';
import { isNotCodingCall } from './not-coding';

const bash = (command: string) =>
  isNotCodingCall({ input: { command }, toolName: 'bash' });
const gh = (command: string) =>
  isNotCodingCall({ input: { command }, toolName: 'gh' });

describe('isNotCodingCall', () => {
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
      'git push --receive-pack=./evil ../local',
      'git -c core.sshCommand=x push',
      'cd /tmp && npm test',
      'cd ~ && git push',
      'gh pr comment 3 --edit-last',
      'gh issue create --web',
      'gh issue view 3 --comment',
      'gh api -X POST repos/o/r/issues',
      'gh api repos/o/r/issues -f title=x',
      'gh api graphql',
    ]) {
      expect(bash(command) || gh(command)).toBe(false);
    }
  });

  test('publishing finished work skips Jev, wrapped or not', () => {
    for (const command of [
      'git push -u origin feat/mcp-legacy-sse',
      'cd /home/user/kyto && git push -u origin feat/mcp-legacy-sse 2>&1 | tail -5',
      'git -C /home/user/kyto push origin HEAD:u0123/fix',
      'gh pr create --repo o/r --base main --head kyto-agent:u0123/fix --title x --body y',
      'gh issue create --repo o/r --title x --body y',
      'gh pr comment 3 --body thanks',
      'gh repo fork o/r --clone=false',
    ]) {
      expect(gh(command)).toBe(true);
    }
  });

  test('only the shell tools, and only a command string', () => {
    expect(
      isNotCodingCall({ input: { code: 'true' }, toolName: 'codeMode' })
    ).toBe(false);
    expect(
      isNotCodingCall({ input: { script: 'true' }, toolName: 'bash' })
    ).toBe(false);
  });
});
