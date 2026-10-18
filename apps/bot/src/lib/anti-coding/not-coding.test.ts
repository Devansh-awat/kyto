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

  test('skips Jev for starting a PR branch and checking gh auth', () => {
    expect(
      bash(
        'git -C kyto switch -c fix/no-pings && git -C kyto add a.ts && git -C kyto commit -m x'
      )
    ).toBe(true);
    expect(bash('git checkout -b u0123/fix')).toBe(true);
    expect(gh('auth status; repo view Devansh-awat/kyto --json url')).toBe(
      true
    );
    for (const command of [
      'git checkout -- a.ts',
      'git checkout main',
      'git switch -c -x',
      'git switch -c a b',
      'gh auth login',
      'gh auth token',
    ]) {
      expect(bash(command) || gh(command)).toBe(false);
    }
  });

  test('reads a gh tool command written without its gh', () => {
    expect(gh('repo view Devansh-awat/kyto --json name,url')).toBe(true);
    expect(gh('pr create --repo o/r --title x --body y')).toBe(true);
    expect(gh('repo delete o/r --yes')).toBe(false);
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
      'git diff --output=patch',
      'git init --template=./hooks',
      'git add . ; npm test',
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
      // #108: a docs-only skill repo, refused at 0.90 and sent to OpenCode.
      'git init; git add SKILL.md; git commit -m "add skill"; gh repo create kyto-agent/fabric-mod-skill --public --source . --push',
      'git add -A && git commit -m x && git push',
    ]) {
      expect(gh(command)).toBe(true);
    }
  });

  test('a chain of exempt commands is exempt, quoted text is only text', () => {
    // The owner's refused "do it" on 2026-10-11, verbatim in shape.
    for (const command of [
      'cd /home/user/kyto && git status --short && git branch --show-current && git log --oneline -1',
      'cd /home/user/kyto && git push -u origin feat/x 2>&1 | tail -5 && gh pr create --repo o/r --base main --head feat/x --title "feat(mcp): x" --body "Adds a fallback (GET stream, then POSTs). Tests: 7/7; full suite not run.\nKnown gap: none."',
      "gh issue comment 3 --body 'costs $5 & (maybe) more'",
      // The 08:16 retry, still refused before escapes were read: markdown code.
      'cd /home/user/kyto && git push -u origin feat/x 2>&1 | tail -5 && gh pr create --title "x" --body "GET stream, \\`endpoint\\` event.\n\nTests: \\`bun test\\` 7/7." 2>&1 | tail -5',
    ]) {
      expect(gh(command)).toBe(true);
    }
    for (const command of [
      'git status && npm test',
      'git push 2>&1 | tail -5 | sh',
      'gh pr create --title x --body "$(cat body.md)"',
      'gh pr create --title x --body "`id`"',
      'gh pr create --title x --body "a \\\\`id`"',
      'cd $HOME && git status',
      'git status ||  true',
    ]) {
      expect(gh(command)).toBe(false);
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

  test('cloning a repo to read it skips Jev', () => {
    for (const command of [
      'git clone --depth 1 https://github.com/Yinsongxu/LLM2Jev',
      'cd /tmp && git clone -q --depth 1 https://github.com/o/r t1 2>&1 | tail -3',
      'git -C repo fetch origin',
      'gh repo clone o/r',
    ]) {
      expect(isNotCodingCall({ input: { command }, toolName: 'bash' })).toBe(
        true
      );
    }
  });

  test('a clone that could run a program still goes to Jev', () => {
    for (const command of [
      'git clone --upload-pack=evil https://github.com/o/r',
      'git clone --template=/tmp/hooks https://github.com/o/r',
      'git clone ext::sh -c evil',
      'git -c core.hooksPath=/x clone https://github.com/o/r',
      'gh repo clone o/r -- --template=/tmp/hooks',
      'git clone https://github.com/o/r && cd r && npm install',
    ]) {
      expect(isNotCodingCall({ input: { command }, toolName: 'bash' })).toBe(
        false
      );
    }
  });
});
