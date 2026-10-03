import { describe, expect, test } from 'bun:test';
import { flaggedItems } from './moderation-flags';

describe('flaggedItems', () => {
  test('a tool result counts only for sexual categories', () => {
    expect(
      flaggedItems({
        items: [
          { source: 'tool result', text: 'news about a war' },
          { source: 'tool result', text: 'nsfw page' },
          { source: 'message', text: 'hate' },
          { source: 'reply', text: 'fine' },
        ],
        results: [
          { categories: { sexual: false, violence: true }, flagged: true },
          { categories: { sexual: true, violence: false }, flagged: true },
          { categories: { hate: true, sexual: null }, flagged: true },
          { categories: { sexual: false }, flagged: false },
        ],
      })
    ).toEqual([
      { categories: ['sexual'], source: 'tool result' },
      { categories: ['hate'], source: 'message' },
    ]);
  });

  test('bare violence and harassment never count; their sub-categories do', () => {
    expect(
      flaggedItems({
        items: [
          { source: 'message', text: 'kick em' },
          { source: 'reply', text: 'noob bot' },
          { source: 'message', text: 'gore' },
          { source: 'message', text: 'threat' },
        ],
        results: [
          { categories: { violence: true }, flagged: true },
          { categories: { harassment: true }, flagged: true },
          {
            categories: { violence: true, 'violence/graphic': true },
            flagged: true,
          },
          {
            categories: { harassment: true, 'harassment/threatening': true },
            flagged: true,
          },
        ],
      })
    ).toEqual([
      { categories: ['violence/graphic'], source: 'message' },
      { categories: ['harassment/threatening'], source: 'message' },
    ]);
  });
});
