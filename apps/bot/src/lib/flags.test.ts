import { describe, expect, test } from 'bun:test';
import { parseFlags, withoutFlags } from '@/lib/flags';

describe('parseFlags', () => {
  test('a question that quotes a flag is not flags', () => {
    expect(parseFlags('what does --model do?')).toBeNull();
    expect(parseFlags('what does --model do')).toBeNull();
    expect(parseFlags('try `--reasoning high` sometime')).toBeNull();
    expect(parseFlags('pass --verbose to it')).toBeNull();
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

describe('flags ending a line', () => {
  // Lily's message: the flag ended the first line, and the turn ran on the
  // randomly drawn effort instead.
  test('a flag at the end of a line counts', () => {
    expect(
      parseFlags(
        'output just this codeblock on a new message --reasoning high\n\n```\nhi\n```'
      )
    ).toEqual({
      flags: {
        reasoning: 'high',
        rest: 'output just this codeblock on a new message\n\n```\nhi\n```',
      },
      ok: true,
    });
  });

  test('several at the end of the message', () => {
    expect(parseFlags('why is the sky blue --model luna --no-memory')).toEqual({
      flags: { memory: 'stale', model: 'luna', rest: 'why is the sky blue' },
      ok: true,
    });
  });

  test('never inside a code block', () => {
    expect(parseFlags('look:\n```\nrun it --reasoning high\n```')).toBeNull();
  });

  test('withoutFlags takes a trailing flag off what the model reads', () => {
    expect(withoutFlags('<@U0BD3555UCQ> hi there --reasoning low')).toBe(
      '<@U0BD3555UCQ> hi there'
    );
  });
});
