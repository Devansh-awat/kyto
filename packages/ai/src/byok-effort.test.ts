import { describe, expect, test } from 'bun:test';
import { byokEffortFormat, tuneBody } from './agent';
import type { ModelAttempt } from './providers/attempts';

function attempt(provider: string): ModelAttempt {
  return {
    apiKey: 'test',
    baseURL: 'https://example.invalid/v1',
    byokProvider: provider.replace('byok-', ''),
    model: 'z-ai/glm-5.3',
    provider,
  };
}

function reasoningSent(provider: string, explicitEffort: boolean): unknown {
  const tuned = tuneBody(
    JSON.stringify({ messages: [], model: 'z-ai/glm-5.3' }),
    attempt(provider),
    undefined,
    undefined,
    undefined,
    { explicitEffort, flex: false, historyMessages: 0, reasoningEffort: 'low' }
  );
  return tuned ? JSON.parse(tuned).reasoning : undefined;
}

// Issue #73: unset, BYOK GLM thought at its own default until the output cap.
describe('reasoning effort on BYOK attempts', () => {
  test('a chosen effort reaches an OpenRouter-format BYOK endpoint', () => {
    expect(reasoningSent('byok-hackclub', true)).toEqual({ effort: 'low' });
    expect(reasoningSent('byok-openrouter', true)).toEqual({ effort: 'low' });
  });

  test('no effort is sent when none was chosen', () => {
    expect(reasoningSent('byok-hackclub', false)).toBeUndefined();
  });

  test('a custom endpoint gets the flat reasoning_effort on a chosen effort', () => {
    const body = (explicit: boolean) =>
      JSON.parse(
        tuneBody(
          JSON.stringify({ messages: [], model: 'glm-5.3' }),
          attempt('byok-custom'),
          undefined,
          undefined,
          undefined,
          {
            explicitEffort: explicit,
            flex: false,
            historyMessages: 0,
            reasoningEffort: 'low',
          }
        ) ?? '{}'
      );
    expect(body(true).reasoning_effort).toBe('low');
    expect(body(true).reasoning).toBeUndefined();
    expect(body(false).reasoning_effort).toBeUndefined();
  });

  test('an effort past high is sent as high', () => {
    for (const provider of ['byok-hackclub', 'byok-custom']) {
      const sent = JSON.parse(
        tuneBody(
          JSON.stringify({ messages: [], model: 'glm-5.3' }),
          attempt(provider),
          undefined,
          undefined,
          undefined,
          {
            explicitEffort: true,
            flex: false,
            historyMessages: 0,
            reasoningEffort: 'xhigh',
          }
        ) ?? '{}'
      );
      expect(sent.reasoning?.effort ?? sent.reasoning_effort).toBe('high');
    }
  });

  test('never sent to an endpoint that rejects the field', () => {
    expect(reasoningSent('byok-openai', true)).toBeUndefined();
  });
});

describe('which BYOK keys take an effort, and in what format', () => {
  const format = (provider: string, model: string) =>
    byokEffortFormat({ ...attempt(provider), model });

  test('reasoning models get the flat field, older ones none', () => {
    expect(format('byok-openai', 'gpt-5.5')).toBe('flat');
    expect(format('byok-openai', 'o4-mini')).toBe('flat');
    expect(format('byok-openai', 'gpt-4o')).toBeUndefined();
    expect(format('byok-xai', 'grok-4.3')).toBe('flat');
    expect(format('byok-xai', 'grok-4')).toBeUndefined();
    expect(format('byok-groq', 'openai/gpt-oss-120b')).toBe('flat');
    expect(format('byok-groq', 'moonshotai/kimi-k2-instruct')).toBeUndefined();
    expect(format('gemini', 'gemini-3-flash-preview')).toBe('flat');
  });

  test('Anthropic ignores the field; OpenRouter-format and custom pass it', () => {
    expect(format('byok-anthropic', 'claude-sonnet-5')).toBeUndefined();
    expect(format('byok-openrouter', 'anthropic/claude-sonnet-5')).toBe(
      'nested'
    );
    expect(format('byok-custom', 'anything')).toBe('flat');
  });

  test('the flat field is sent to gpt-5 and never to gpt-4o', () => {
    const sent = (model: string) =>
      JSON.parse(
        tuneBody(
          JSON.stringify({ messages: [], model }),
          { ...attempt('byok-openai'), model },
          undefined,
          undefined,
          undefined,
          {
            explicitEffort: true,
            flex: false,
            historyMessages: 0,
            reasoningEffort: 'medium',
          }
        ) ?? '{}'
      );
    expect(sent('gpt-5.5').reasoning_effort).toBe('medium');
    expect(sent('gpt-4o').reasoning_effort).toBeUndefined();
  });
});
