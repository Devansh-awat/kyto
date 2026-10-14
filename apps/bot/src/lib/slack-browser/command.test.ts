import { describe, expect, test } from 'bun:test';
import {
  conversationUrl,
  isSamePage,
  parseCommand,
  splitCommand,
} from '@/lib/slack-browser/command';

describe('splitCommand', () => {
  test('groups quoted words and never expands anything', () => {
    expect(splitCommand(`fill @e3 "hello world"`)).toEqual([
      'fill',
      '@e3',
      'hello world',
    ]);
    expect(splitCommand(`type @e1 'it''s $(id)'`)).toEqual([
      'type',
      '@e1',
      'its $(id)',
    ]);
    expect(splitCommand(`fill @e1 ""`)).toEqual(['fill', '@e1', '']);
  });

  test('refuses an unclosed quote', () => {
    expect(parseCommand(`fill @e1 "oops`).ok).toBe(false);
  });
});

describe('parseCommand', () => {
  test('lets interaction verbs through', () => {
    for (const command of [
      'snapshot -i',
      'click @e12',
      'fill @e3 "hi there"',
      'press Enter',
      'scroll down 500',
      'wait 2000',
      'get text @e4',
      'find role button click --name Submit',
      'tab list',
      'tab 2',
      'skills get core --full',
      'open https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB',
      'tab new https://hackclub.enterprise.slack.com/archives/C1',
    ]) {
      expect(parseCommand(command)).toEqual({
        args: expect.any(Array),
        ok: true,
      });
    }
  });

  test('runs script in the page, whose network is Slack only', () => {
    for (const command of [
      'eval document.title',
      'eval "[...document.querySelectorAll(\'button\')].length"',
      'wait --fn "document.readyState === \'complete\'"',
    ]) {
      expect(parseCommand(command).ok).toBe(true);
    }
  });

  test('refuses what reaches past the browser into the host', () => {
    for (const command of [
      'upload @e1 /app/apps/bot/.env',
      'screenshot /app/x.png',
      'pdf /tmp/x.pdf',
      'download @e1 /tmp/x',
      'read http://169.254.169.254/',
      'batch "eval 1"',
      'connect 9222',
      'cookies',
      'network requests',
      'set headers {}',
      'state load /tmp/s.json',
      'snapshot --executable-path /bin/sh',
      'get cdp-url',
      'diff url https://example.com https://slack.com',
      'skills path',
      'tab https://example.com',
    ]) {
      expect(parseCommand(command).ok).toBe(false);
    }
  });

  test('opens only https Slack URLs', () => {
    for (const url of [
      'file:///etc/passwd',
      'http://app.slack.com/client',
      'https://example.com',
      'https://slack.com.evil.io',
      'https://127.0.0.1:9223/json',
      'chrome://settings',
      'javascript:alert(1)',
      'app.slack.com',
    ]) {
      expect(parseCommand(`open ${url}`).ok).toBe(false);
      expect(parseCommand(`tab new ${url}`).ok).toBe(false);
    }
    expect(parseCommand('open').ok).toBe(false);
  });

  test('builds client URLs from ids and message links', () => {
    const team = 'T0266FRGM';
    expect(conversationUrl({ target: 'C0B7QEK0MQB', team })).toBe(
      'https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB'
    );
    expect(
      conversationUrl({
        target: 'C0B7QEK0MQB',
        team,
        threadTs: '1791903295.656479',
      })
    ).toBe(
      'https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB/thread/C0B7QEK0MQB-1791903295.656479'
    );
    expect(
      conversationUrl({ target: 'slack:C0B7QEK0MQB:1791904674.465549', team })
    ).toBe(
      'https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB/thread/C0B7QEK0MQB-1791904674.465549'
    );
    // A reply's link opens its parent's thread; a top-level one, its own.
    expect(
      conversationUrl({
        target:
          'https://hackclub.slack.com/archives/C0B7QEK0MQB/p1791903453922089?thread_ts=1791903295.656479&cid=C0B7QEK0MQB',
        team,
      })
    ).toBe(
      'https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB/thread/C0B7QEK0MQB-1791903295.656479'
    );
    expect(
      conversationUrl({
        target:
          'https://hackclub.slack.com/archives/C0B7QEK0MQB/p1791903352264749',
        team,
      })
    ).toBe(
      'https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB/thread/C0B7QEK0MQB-1791903352.264749'
    );
    for (const target of [
      'https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB',
      'https://evil.example/archives/C0B7QEK0MQB/p1791903352264749',
      'general',
    ]) {
      expect(conversationUrl({ target, team })).toBeUndefined();
    }
    expect(
      conversationUrl({ target: 'C0B7QEK0MQB', team, threadTs: 'soon' })
    ).toBeUndefined();
  });

  test('reads a wait as seconds, not a selector or milliseconds', () => {
    expect(parseCommand('wait 3s')).toEqual({
      args: ['wait', '3000'],
      ok: true,
    });
    expect(parseCommand('wait 5')).toEqual({
      args: ['wait', '5000'],
      ok: true,
    });
    expect(parseCommand('wait 2000')).toEqual({
      args: ['wait', '2000'],
      ok: true,
    });
    expect(parseCommand('wait @e3').ok).toBe(true);
  });

  test('passes a script through as typed, quotes and all', () => {
    expect(
      parseCommand('eval document.querySelectorAll("button").length')
    ).toEqual({
      args: ['eval', 'document.querySelectorAll("button").length'],
      ok: true,
    });
    expect(
      parseCommand(
        `eval [...document.querySelectorAll('button')].filter(b => b && b.disabled)`
      )
    ).toEqual({
      args: [
        'eval',
        "[...document.querySelectorAll('button')].filter(b => b && b.disabled)",
      ],
      ok: true,
    });
    expect(parseCommand(`eval "document.title + 'x'"`)).toEqual({
      args: ['eval', "document.title + 'x'"],
      ok: true,
    });
    expect(parseCommand(`eval "a" + "b"`)).toEqual({
      args: ['eval', '"a" + "b"'],
      ok: true,
    });
    expect(
      parseCommand('wait --fn document.querySelector(".x") !== null')
    ).toEqual({
      args: ['wait', '--fn', 'document.querySelector(".x") !== null'],
      ok: true,
    });
  });

  test('refuses shell operators, which never reach a shell', () => {
    expect(parseCommand('snapshot -i | grep robot').ok).toBe(false);
    expect(parseCommand('fill @e1 "a" && click @e2').ok).toBe(false);
    expect(parseCommand('fill @e1 "a | b"').ok).toBe(true);
  });

  test('knows when an open would only reload the same page', () => {
    const current = 'https://app.slack.com/client/E09V59WQY1E/C0B7QEK0MQB';
    expect(
      isSamePage({
        current,
        target: 'https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB/',
      })
    ).toBe(true);
    expect(
      isSamePage({
        current,
        target:
          'https://app.slack.com/client/E09V59WQY1E/C0B7QEK0MQB/thread/C0B7QEK0MQB-1.2',
      })
    ).toBe(false);
    expect(isSamePage({ current, target: 'not a url' })).toBe(false);
  });

  test('refuses a channel id where the workspace id goes', () => {
    expect(
      parseCommand('open https://app.slack.com/client/C0B7QEK0MQB/C0B7QEK0MQB')
        .ok
    ).toBe(false);
    expect(
      parseCommand(
        'open https://app.slack.com/client/E09V59WQY1E/C0B7QEK0MQB/thread/C0B7QEK0MQB-1791903295.656479'
      ).ok
    ).toBe(true);
    expect(parseCommand('open https://app.slack.com/client').ok).toBe(true);
  });
});
