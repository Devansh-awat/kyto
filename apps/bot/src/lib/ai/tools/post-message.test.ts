import { describe, expect, test } from 'bun:test';
import { ensureAppMembershipForPost } from './post-message';

describe('ensureAppMembershipForPost', () => {
  test('joins a target channel only when the app is not a member', async () => {
    const calls: string[] = [];
    await ensureAppMembershipForPost({
      channel: 'C123',
      client: {
        conversations: {
          info: () => {
            calls.push('info');
            return Promise.resolve({ channel: { is_member: false } });
          },
          join: () => {
            calls.push('join');
            return Promise.resolve();
          },
        },
      },
    });
    expect(calls).toEqual(['info', 'join']);
  });

  test('does not rejoin a channel the app already belongs to', async () => {
    const calls: string[] = [];
    await ensureAppMembershipForPost({
      channel: 'C0BDH1FNCTX',
      client: {
        conversations: {
          info: () => {
            calls.push('info');
            return Promise.resolve({ channel: { is_member: true } });
          },
          join: () => {
            calls.push('join');
            return Promise.resolve();
          },
        },
      },
    });
    expect(calls).toEqual(['info']);
  });
});
