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
    const result = await sanitizeGitRepos({ dirs: [root], runner });
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
});
