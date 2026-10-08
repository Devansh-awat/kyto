import { describe, expect, test } from 'bun:test';
import { parseSlackPermalink } from './ids';

describe('parseSlackPermalink', () => {
  test('a top-level message is its own thread', () => {
    expect(
      parseSlackPermalink(
        'https://hackclub.slack.com/archives/C0710J7F4U9/p1788382529066419'
      )
    ).toEqual({
      channelId: 'C0710J7F4U9',
      threadTs: '1788382529.066419',
      ts: '1788382529.066419',
    });
  });

  test('a reply reads the thread named by thread_ts', () => {
    expect(
      parseSlackPermalink(
        'https://hackclub.slack.com/archives/C0266FRGT/p1777485207073979?thread_ts=1776901976.751049&cid=C0266FRGT'
      )
    ).toEqual({
      channelId: 'C0266FRGT',
      threadTs: '1776901976.751049',
      ts: '1777485207.073979',
    });
  });

  test('anything else is not a permalink', () => {
    expect(parseSlackPermalink('https://example.com/archives/C1/p1')).toBe(
      null
    );
    expect(
      parseSlackPermalink(
        'https://evil.com/x.slack.com/archives/C0266FRGT/p1777485207073979'
      )
    ).toBe(null);
    expect(parseSlackPermalink('1777485207.073979')).toBe(null);
  });
});
