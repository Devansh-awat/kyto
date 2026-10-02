import { describe, expect, test } from 'bun:test';
import { parseCommand, splitCommand } from '@/lib/slack-browser/command';

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

  test('refuses what reaches past the browser into the host', () => {
    for (const command of [
      'eval document.cookie',
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
      'wait --fn "fetch(1)"',
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
});
