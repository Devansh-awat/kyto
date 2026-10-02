import { describe, expect, test } from 'bun:test';
import {
  isSlackHost,
  isSlackWebMethodAllowed,
  mergeCookies,
  replaceBytes,
} from '@/lib/slack-web-proxy';

describe('isSlackWebMethodAllowed', () => {
  test('refuses every way of sending, editing or deleting a message', () => {
    for (const method of [
      'chat.postMessage',
      'chat.update',
      'chat.delete',
      'chat.meMessage',
      'chat.scheduleMessage',
      'chat.someMethodSlackAddsLater',
      'drafts.create',
      'files.upload',
      'files.completeUploadExternal',
    ]) {
      expect(isSlackWebMethodAllowed(method)).toBe(false);
    }
  });

  test('refuses account, channel and admin changes', () => {
    for (const method of [
      'auth.signout',
      'conversations.leave',
      'conversations.archive',
      'conversations.invite',
      'users.profile.set',
      'admin.users.remove',
      'emoji.remove',
    ]) {
      expect(isSlackWebMethodAllowed(method)).toBe(false);
    }
  });

  test('lets reads and button clicks through', () => {
    for (const method of [
      'client.userBoot',
      'conversations.history',
      'conversations.view',
      'chat.getPermalink',
      'drafts.list',
      'blocks.actions',
      'views.submit',
      'users.info',
      'files.info',
    ]) {
      expect(isSlackWebMethodAllowed(method)).toBe(true);
    }
  });
});

describe('isSlackHost', () => {
  test('accepts slack.com and its subdomains only', () => {
    expect(isSlackHost('app.slack.com')).toBe(true);
    expect(isSlackHost('hackclub.enterprise.slack.com')).toBe(true);
    expect(isSlackHost('slack.com')).toBe(true);
    expect(isSlackHost('evilslack.com')).toBe(false);
    expect(isSlackHost('slack.com.evil.io')).toBe(false);
    expect(isSlackHost('169.254.169.254')).toBe(false);
  });
});

describe('replaceBytes', () => {
  test('replaces every occurrence, including in binary bodies', () => {
    const bytes = Buffer.concat([
      Buffer.from('token=AAA&x=1&t=AAA'),
      Buffer.from([0, 255]),
    ]);
    const out = Buffer.from(replaceBytes({ bytes, from: 'AAA', to: 'xoxc-1' }));
    expect(out.subarray(0, -2).toString()).toBe('token=xoxc-1&x=1&t=xoxc-1');
    expect([...out.subarray(-2)]).toEqual([0, 255]);
  });

  test('returns the input untouched when there is nothing to replace', () => {
    const bytes = Buffer.from('nothing here');
    expect(replaceBytes({ bytes, from: 'AAA', to: 'B' })).toBe(bytes);
  });
});

describe('mergeCookies', () => {
  test("drops the browser's own session cookies for the account's", () => {
    expect(
      mergeCookies({ browser: 'b=1; d=forged; d-s=2; lc=3', session: 'd=real' })
    ).toBe('b=1; lc=3; d=real');
    expect(mergeCookies({ browser: null, session: 'd=real' })).toBe('d=real');
  });
});
