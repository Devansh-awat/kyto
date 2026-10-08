import { describe, expect, test } from 'bun:test';
import {
  buildReplyFooter,
  FEEDBACK_ACTION,
  formatDuration,
  parseFeedbackValue,
} from './footer';

describe('formatDuration', () => {
  test('seconds with one decimal under a minute', () => {
    expect(formatDuration(12_345)).toBe('12.3s');
    expect(formatDuration(400)).toBe('0.4s');
  });
  test('minutes and seconds from a minute on', () => {
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(120_000)).toBe('2m');
  });
});

describe('buildReplyFooter', () => {
  test('nothing at all when the footer is off and the usual model answered', () => {
    expect(buildReplyFooter({ durationMs: 1000, showFooter: false })).toBe(
      null
    );
  });

  test('timing and both buttons when on', () => {
    const footer = buildReplyFooter({
      durationMs: 3200,
      model: 'z-ai/glm-5.3-flash',
      showFooter: true,
    });
    expect(footer?.fallbackText).toBe('_done in 3.2s_');
    const actions = footer?.blocks.find(
      (block) => block.type === 'context_actions'
    );
    const thumbs =
      actions?.type === 'context_actions' ? actions.elements[0] : undefined;
    expect(thumbs?.action_id).toBe(FEEDBACK_ACTION);
    expect(parseFeedbackValue(thumbs?.positive_button.value)).toEqual({
      model: 'z-ai/glm-5.3-flash',
      rating: 'up',
    });
    expect(parseFeedbackValue(thumbs?.negative_button.value)).toEqual({
      model: 'z-ai/glm-5.3-flash',
      rating: 'down',
    });
  });

  test('a thumb value without a model, and garbage', () => {
    expect(parseFeedbackValue('down:')).toEqual({
      model: undefined,
      rating: 'down',
    });
    expect(parseFeedbackValue('sideways:x')).toBe(null);
    expect(parseFeedbackValue(undefined)).toBe(null);
  });

  test('the fallback note shows even with the footer turned off', () => {
    const footer = buildReplyFooter({
      durationMs: 1000,
      fallback: { model: 'gemini-2.5-flash', primaryLabel: 'glm 5.3 flash' },
      showFooter: false,
    });
    expect(footer?.blocks).toHaveLength(1);
    expect(footer?.fallbackText).toContain('gemini-2.5-flash');
    expect(footer?.fallbackText).toContain('weaker model');
  });
});

describe('buildReplyFooter fallback reason', () => {
  test('names the outage when Hack Club AI reported one', () => {
    const footer = buildReplyFooter({
      durationMs: 1000,
      fallback: {
        model: 'z-ai/glm-5.3-flash',
        outage: 'Hack Club AI reports it is down',
        primaryLabel: 'gpt-6 luna on hack club ai',
      },
      showFooter: false,
    });
    expect(footer?.fallbackText).toContain('(hack club ai reports it is down)');
  });
});
