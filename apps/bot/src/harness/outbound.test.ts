import { describe, expect, test } from 'bun:test';
import {
  createStreamFilter,
  filterOutbound,
  filterOutboundDeep,
} from './outbound';

describe('filterOutbound', () => {
  test('strips the private thinking block, closed or not (#223)', () => {
    const block =
      '<your_previous_thinking>\nYour own private reasoning\n[your previous turn]\nsecret</your_previous_thinking>';
    expect(filterOutbound(`_done in 4m_${block}`)).toBe('_done in 4m_');
    expect(
      filterOutbound(
        'hi <your_previous_thinking>\nYour own private reasoning cut off'
      )
    ).toBe('hi ');
    expect(
      filterOutbound('the <your_previous_thinking> tag is internal.')
    ).toBe('the <your_previous_thinking> tag is internal.');
  });

  test('also inside blocks', () => {
    const out = filterOutboundDeep([
      {
        text: 'ok<your_previous_thinking>\nYour own private reasoning x</your_previous_thinking>',
      },
    ]);
    expect(out).toEqual([{ text: 'ok' }]);
  });

  test('leaves ordinary text alone', () => {
    expect(filterOutbound('a < b and <@U1>')).toBe('a < b and <@U1>');
  });
});

describe('createStreamFilter', () => {
  test('drops the inner lines of a block split across pieces (#223)', () => {
    const stream = createStreamFilter();
    const filter = stream.push;
    const out = [
      'answer.<your_prev',
      'ious_thinking>\nYour own private reasoning\nline one\n',
      'line two\n',
      'line three</your_previous_thinking> tail',
      ' more',
    ]
      .map((piece) => filter(piece))
      .join('');
    expect(out).toBe('answer. tail more');
    const quoted = createStreamFilter().push;
    expect(
      [quoted('see <your_previous'), quoted('_thinking> for more')].join('')
    ).toBe('see <your_previous_thinking> for more');
  });

  test('a block that never closes does not take the reply with it (#223)', () => {
    const stream = createStreamFilter();
    const shown =
      stream.push(
        '<your_previous_thinking>\nYour own private reasoning AND tools.\nUse it to pick up.\n\nHere is the real answer.'
      ) + stream.push(' More of it.');
    expect(shown + stream.flush()).toBe('Here is the real answer. More of it.');
    expect(
      filterOutbound(
        '<your_previous_thinking>\nYour own private reasoning x\n\nanswer'
      ).trim()
    ).toBe('answer');
  });
});
