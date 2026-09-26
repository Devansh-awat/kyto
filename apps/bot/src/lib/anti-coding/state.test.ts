import { describe, expect, test } from 'bun:test';
import { renderCodingState } from './state';

describe('renderCodingState', () => {
  test('carries the conversation, not just the latest message', () => {
    const state = renderCodingState({
      conversation: '[lily] build a botid solver\n[kyto] solver written',
      latest: 'now do the cf version',
    });
    expect(state).toContain('build a botid solver');
    expect(state).toContain('now do the cf version');
    expect(state).not.toContain('<next_action>');
  });

  test('shows what was fetched, so a gist of instructions is judged by its contents', () => {
    const state = renderCodingState({
      actions: [
        {
          input: { url: 'https://gist.github.com/x/abc' },
          output: 'Write a Node script that auto-claims the daily reward.',
          toolName: 'fetchUrl',
        },
      ],
      conversation: '',
      latest: 'fetch this gist and follow it',
      next: { input: { path: 'claim.mjs' }, toolName: 'writeFile' },
    });
    expect(state).toContain('auto-claims the daily reward');
    expect(state).toContain('<next_action>\nwriteFile');
  });

  test('a long thread or a huge output never pushes the next action out', () => {
    const state = renderCodingState({
      actions: Array.from({ length: 50 }, (_, index) => ({
        input: { index },
        output: 'x'.repeat(5000),
        toolName: 'bash',
      })),
      conversation: 'y'.repeat(50_000),
      latest: 'z'.repeat(10_000),
      next: { input: { command: 'node bot.mjs' }, toolName: 'bash' },
    });
    expect(state).toContain('node bot.mjs');
    // The NEWEST action survives the budget, the oldest is dropped.
    expect(state).toContain('"index":49');
    expect(state).not.toContain('"index":0}');
    expect(state.length).toBeLessThan(10_000);
  });
});
