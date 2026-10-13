import { describe, expect, test } from 'bun:test';
import { splitUnderlines } from './underline';

describe('splitUnderlines', () => {
  test('text without an underline stays one markdown part', () => {
    expect(splitUnderlines('a **b**\n\nc')).toEqual([
      { markdown: 'a **b**\n\nc' },
    ]);
  });

  test('an underlined line becomes a rich_text block between markdown', () => {
    const parts = splitUnderlines('before\nthis is <u>example</u> text\nafter');
    expect(parts[0]).toEqual({ markdown: 'before' });
    expect(parts[1]).toEqual({
      block: {
        elements: [
          {
            elements: [
              { text: 'this is ', type: 'text' },
              { style: { underline: true }, text: 'example', type: 'text' },
              { text: ' text', type: 'text' },
            ],
            type: 'rich_text_section',
          },
        ],
        type: 'rich_text',
      },
      fallback: 'this is example text',
    });
    expect(parts[2]).toEqual({ markdown: 'after' });
  });

  test('styles nest and links and mentions survive', () => {
    const [part] = splitUnderlines(
      '**<u>hi</u>** see [docs](https://x.dev) <@U0123ABCD>'
    );
    expect(part && 'block' in part && part.block.elements[0]).toEqual({
      elements: [
        { style: { bold: true, underline: true }, text: 'hi', type: 'text' },
        { text: ' see ', type: 'text' },
        { text: 'docs', type: 'link', url: 'https://x.dev' },
        { text: ' ', type: 'text' },
        { type: 'user', user_id: 'U0123ABCD' },
      ],
      type: 'rich_text_section',
    });
  });

  test('a bullet keeps its list shape', () => {
    const [part] = splitUnderlines('- <u>one</u>');
    expect(part && 'block' in part && part.block.elements[0]?.type).toBe(
      'rich_text_list'
    );
  });

  test('never inside code', () => {
    const text = '```\n<u>x</u>\n```\n`<u>y</u>`';
    expect(splitUnderlines(text)).toEqual([{ markdown: text }]);
  });
});
