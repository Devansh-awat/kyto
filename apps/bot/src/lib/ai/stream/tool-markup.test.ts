import { describe, expect, test } from 'bun:test';
import { createToolMarkupFilter } from './tool-markup';

const LEAK = '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="postMessage">';

describe('createToolMarkupFilter', () => {
  test('leaves ordinary prose alone', () => {
    const filter = createToolMarkupFilter();
    expect(filter.push('postMessage + blocks ✓. Now pin / unpin:').text).toBe(
      'postMessage + blocks ✓. Now pin / unpin:'
    );
    expect(filter.flush().text).toBe('');
    expect(filter.leaked).toBe(false);
  });

  test('keeps the reply written before the leak, drops the markup', () => {
    const filter = createToolMarkupFilter();
    const split = filter.push(`Now postMessage:\n${LEAK}`);
    expect(split.text).toBe('Now postMessage:\n');
    expect(split.dropped).toBe(LEAK);
    expect(filter.leaked).toBe(true);
  });

  test('drops everything after the marker, not just the tags', () => {
    // The arguments are the bulk of it — a whole Block Kit payload in the turn
    // this was found in — so a tag-by-tag strip would still post the junk.
    const filter = createToolMarkupFilter();
    filter.push(LEAK);
    expect(filter.push('{"type":"section"}</｜DSML｜parameter>').text).toBe('');
    expect(filter.push('and back to normal prose?').text).toBe('');
  });

  test('catches a marker split across two deltas', () => {
    const filter = createToolMarkupFilter();
    expect(filter.push('done. <').text).toBe('done. ');
    expect(filter.push('｜DSML｜tool_calls>').text).toBe('');
    expect(filter.leaked).toBe(true);
  });

  test('a lone trailing < is released at the end of the stream', () => {
    const filter = createToolMarkupFilter();
    expect(filter.push('a < b').text).toBe('a < b');
    expect(filter.push('x <').text).toBe('x ');
    expect(filter.flush().text).toBe('<');
  });

  test('a Slack mention is never held back', () => {
    const filter = createToolMarkupFilter();
    expect(filter.push('hey <@U123> look').text).toBe('hey <@U123> look');
  });

  test('reports how much it swallowed, for the log', () => {
    const filter = createToolMarkupFilter();
    filter.push(LEAK);
    const more = filter.push('more markup');
    expect(more.dropped).toBe('more markup');
  });
});
