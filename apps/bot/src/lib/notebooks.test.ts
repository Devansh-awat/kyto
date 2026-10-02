import { describe, expect, test } from 'bun:test';
import { applyNotebookEdit } from './notebooks';

describe('applyNotebookEdit', () => {
  test('append adds a line, or starts an empty notebook', () => {
    expect(
      applyNotebookEdit({
        content: '',
        edit: { action: 'append', text: '- a' },
        max: 100,
      })
    ).toEqual({ content: '- a' });
    expect(
      applyNotebookEdit({
        content: '- a\n',
        edit: { action: 'append', text: '- b' },
        max: 100,
      })
    ).toEqual({ content: '- a\n- b' });
  });

  test('replace swaps one exact match and deletes with empty text', () => {
    expect(
      applyNotebookEdit({
        content: '- a\n- b\n- c',
        edit: { action: 'replace', find: '- b\n', text: '' },
        max: 100,
      })
    ).toEqual({ content: '- a\n- c' });
  });

  test('replace refuses a missing or ambiguous find', () => {
    for (const find of ['', 'zzz', '- a']) {
      const result = applyNotebookEdit({
        content: '- a\n- a',
        edit: { action: 'replace', find, text: 'x' },
        max: 100,
      });
      expect('error' in result).toBe(true);
    }
  });

  test('an edit past the cap is refused, not truncated', () => {
    // A silent cut would drop whatever sat at the end; the refusal is what
    // makes kevinton condense.
    const result = applyNotebookEdit({
      content: 'x'.repeat(90),
      edit: { action: 'append', text: 'y'.repeat(20) },
      max: 100,
    });
    expect('error' in result).toBe(true);
    expect(
      applyNotebookEdit({
        content: 'x'.repeat(90),
        edit: { action: 'rewrite', text: 'short' },
        max: 100,
      })
    ).toEqual({ content: 'short' });
  });
});
