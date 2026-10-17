import { describe, expect, test } from 'bun:test';
import { githubEventMatches, patternMatches, reactionCount } from './events';

describe('patternMatches', () => {
  test('no pattern matches everything', () => {
    expect(patternMatches({ text: 'anything' })).toBe(true);
  });

  test('plain text is a case-insensitive substring', () => {
    expect(
      patternMatches({ pattern: 'Deploy', text: 'the deploy failed' })
    ).toBe(true);
    expect(patternMatches({ pattern: 'deploy', text: 'all good' })).toBe(false);
  });

  test('regex mode, and a broken regex never matches', () => {
    expect(
      patternMatches({
        pattern: '^v\\d+\\.\\d+',
        regex: true,
        text: 'V1.2 out',
      })
    ).toBe(true);
    expect(patternMatches({ pattern: '(', regex: true, text: '(' })).toBe(
      false
    );
  });
});

describe('githubEventMatches', () => {
  const trigger = (events?: string[]) => ({
    events,
    source: 'github' as const,
  });

  test('no filter takes any event', () => {
    expect(
      githubEventMatches({
        action: undefined,
        event: 'push',
        trigger: trigger(),
      })
    ).toBe(true);
  });

  test('an event name takes every action of it', () => {
    expect(
      githubEventMatches({
        action: 'closed',
        event: 'pull_request',
        trigger: trigger(['pull_request']),
      })
    ).toBe(true);
  });

  test('event.action takes only that action', () => {
    const only = trigger(['pull_request.opened']);
    expect(
      githubEventMatches({
        action: 'opened',
        event: 'pull_request',
        trigger: only,
      })
    ).toBe(true);
    expect(
      githubEventMatches({
        action: 'closed',
        event: 'pull_request',
        trigger: only,
      })
    ).toBe(false);
    expect(
      githubEventMatches({ action: undefined, event: 'push', trigger: only })
    ).toBe(false);
  });
});

describe('reactionCount', () => {
  const reactions = [
    { count: 5, name: 'fire' },
    { count: 4, name: '+1' },
    { count: 3, name: '+1::skin-tone-3' },
  ];

  test('no emoji counts every reaction', () => {
    expect(reactionCount({ reactions })).toBe(12);
  });

  test('an emoji counts it and its skin tones only', () => {
    expect(reactionCount({ emoji: '+1', reactions })).toBe(7);
    expect(reactionCount({ emoji: 'fire', reactions })).toBe(5);
    expect(reactionCount({ emoji: 'eyes', reactions })).toBe(0);
  });
});
