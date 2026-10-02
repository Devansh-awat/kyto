import { describe, expect, test } from 'bun:test';
import { resolverRules } from '@/lib/slack-browser';

describe('resolverRules', () => {
  test('sends Slack to the proxy, lets the CDNs out and nothing else', () => {
    const rules = resolverRules(4433).split(', ');
    expect(rules).toContain('MAP *.slack.com 127.0.0.1:4433');
    expect(rules).toContain('MAP slack.com 127.0.0.1:4433');
    expect(rules).toContain('EXCLUDE *.slack-edge.com');
    // Last, so it catches every name — IP literals and localhost included.
    expect(rules.at(-1)).toBe('MAP * ~NOTFOUND');
  });
});
