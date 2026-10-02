import { describe, expect, test } from 'bun:test';
import { flaggedItems } from './moderation-flags';

describe('flaggedItems', () => {
  test('a tool result counts only for sexual categories', () => {
    expect(
      flaggedItems({
        items: [
          { source: 'tool result', text: 'news about a war' },
          { source: 'tool result', text: 'nsfw page' },
          { source: 'message', text: 'threat' },
          { source: 'reply', text: 'fine' },
        ],
        results: [
          { categories: { sexual: false, violence: true }, flagged: true },
          { categories: { sexual: true, violence: false }, flagged: true },
          { categories: { harassment: true, sexual: null }, flagged: true },
          { categories: { sexual: false }, flagged: false },
        ],
      })
    ).toEqual([
      { categories: ['sexual'], source: 'tool result' },
      { categories: ['harassment'], source: 'message' },
    ]);
  });
});
