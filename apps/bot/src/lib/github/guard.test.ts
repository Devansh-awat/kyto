import { describe, expect, mock, test } from 'bun:test';

const approvals: unknown[] = [];
const queued: unknown[] = [];

mock.module('@repo/db/queries', () => ({
  claimGithubRepo: () => Promise.resolve(),
  getGithubRepos: () => Promise.resolve([]),
  getGithubTrust: () =>
    Promise.resolve({ allRepos: false, repos: ['hackclub/nephthys'] }),
  recordGithubRequest: (row: unknown) => {
    queued.push(row);
    return Promise.resolve();
  },
}));
mock.module('@/lib/approvals/request', () => ({
  requestApproval: (row: unknown) => {
    approvals.push(row);
    return Promise.resolve();
  },
}));
mock.module('./collaborator', () => ({
  isFork: () => Promise.resolve(false),
  kytoCanPush: (repo: string) => Promise.resolve(repo === 'invited/repo'),
}));

const { guardGithubTargets } = await import('./guard');

const base = {
  creates: [],
  isOwner: false,
  threadId: 'slack:D1:1.0',
  userId: 'U1',
};

describe('a push kyto cannot make', () => {
  test('is refused with no card and nothing queued, even when trusted', async () => {
    const guard = await guardGithubTargets({
      ...base,
      commandText: 'git push to hackclub/nephthys',
      forkRefs: [],
      repos: ['hackclub/nephthys'],
    });
    expect(guard.allowed).toBe(false);
    expect(guard.allowed ? '' : guard.reason).toContain('Push to a fork');
    expect(approvals).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  test('a push kyto was invited to still goes through', async () => {
    const guard = await guardGithubTargets({
      ...base,
      commandText: 'git push to invited/repo',
      forkRefs: [],
      repos: ['invited/repo'],
    });
    expect(guard.allowed).toBe(true);
  });

  test('a non-push write still goes to the trust gate', async () => {
    const guard = await guardGithubTargets({
      ...base,
      commandText: 'POST /repos/other/repo/labels',
      repos: ['other/repo'],
    });
    expect(guard.allowed).toBe(false);
    expect(approvals).toHaveLength(1);
  });
});
