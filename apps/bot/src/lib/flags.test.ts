import { describe, expect, test } from 'bun:test';
import { parseFlags } from '@/lib/flags';

describe('parseFlags', () => {
  test('a message without a leading flag is not flags', () => {
    expect(parseFlags('what does --model do?')).toBeNull();
    expect(parseFlags('--- a divider')).toBeNull();
  });

  test('model and reasoning together, the question kept', () => {
    expect(
      parseFlags('--model luna --reasoning high why is the sky blue')
    ).toEqual({
      flags: { model: 'luna', reasoning: 'high', rest: 'why is the sky blue' },
      ok: true,
    });
  });

  test('= values and slugs', () => {
    expect(parseFlags('--model=openai/gpt-5.1 --reasoning=low')).toEqual({
      flags: { model: 'openai/gpt-5.1', reasoning: 'low', rest: '' },
      ok: true,
    });
  });

  test('focusmode takes the mentions after it, or none, or off', () => {
    expect(parseFlags('--focusmode <@U0123ABCD> <@U04567890|bo> hi')).toEqual({
      flags: { focus: ['U0123ABCD', 'U04567890'], rest: 'hi' },
      ok: true,
    });
    expect(parseFlags('--focusmode --model haiku')).toEqual({
      flags: { focus: [], model: 'haiku', rest: '' },
      ok: true,
    });
    expect(parseFlags('--focus off')).toEqual({
      flags: { focus: null, rest: '' },
      ok: true,
    });
  });

  test('a missing value or an unknown flag is an error', () => {
    expect(parseFlags('--model')?.ok).toBe(false);
    expect(parseFlags('--model --reasoning high')?.ok).toBe(false);
    expect(parseFlags('--temperature 2')?.ok).toBe(false);
  });
});
