import { describe, expect, test } from 'bun:test';
import { tuneBody } from './agent';
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

  test('never sent to an endpoint that rejects the field', () => {
    expect(reasoningSent('byok-openai', true)).toBeUndefined();
  });
});
