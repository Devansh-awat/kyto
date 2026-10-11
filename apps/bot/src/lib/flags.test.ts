import { describe, expect, test } from 'bun:test';
import { parseFlags, withoutFlags } from '@/lib/flags';

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

  test('--no-memory and --NO-MEMORY differ by case and take no value', () => {
    expect(parseFlags('--no-memory what is x')).toEqual({
      flags: { memory: 'stale', rest: 'what is x' },
      ok: true,
    });
    expect(parseFlags('--NO-MEMORY --model luna hi')).toEqual({
      flags: { memory: 'off', model: 'luna', rest: 'hi' },
      ok: true,
    });
    expect(parseFlags('--No-Memory')).toEqual({
      flags: { memory: 'stale', rest: '' },
      ok: true,
    });
    expect(parseFlags('--memory hi')).toEqual({
      flags: { memory: null, rest: 'hi' },
      ok: true,
    });
  });

  test('a missing value or an unknown flag is an error', () => {
    expect(parseFlags('--model')?.ok).toBe(false);
    expect(parseFlags('--model --reasoning high')?.ok).toBe(false);
    expect(parseFlags('--temperature 2')?.ok).toBe(false);
  });
});

describe('withoutFlags', () => {
  test('takes the flags off and keeps the leading mention', () => {
    expect(
      withoutFlags('<@U0BD3555UCQ> --model luna --reasoning high hi')
    ).toBe('<@U0BD3555UCQ> hi');
    expect(withoutFlags('--NO-MEMORY what is x')).toBe('what is x');
  });

  test('leaves ordinary text and unparseable flags alone', () => {
    expect(withoutFlags('what does --model do?')).toBe('what does --model do?');
    expect(withoutFlags('--temperature 2 hi')).toBe('--temperature 2 hi');
  });
});
