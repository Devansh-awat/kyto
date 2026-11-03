import { describe, expect, test } from 'bun:test';
import { flaggedItems } from './moderation-flags';

describe('flaggedItems', () => {
  test('only sexual categories count, from any source', () => {
    expect(
      flaggedItems({
        items: [
          { source: 'tool result', text: 'news about a war' },
          { source: 'tool result', text: 'nsfw page' },
          { source: 'message', text: 'hate' },
          { source: 'reply', text: 'fine' },
          { source: 'message', text: 'nsfw ask' },
        ],
        results: [
          { categories: { sexual: false, violence: true }, flagged: true },
          { categories: { sexual: true, violence: false }, flagged: true },
          { categories: { hate: true, sexual: null }, flagged: true },
          { categories: { sexual: false }, flagged: false },
          {
            categories: { sexual: true, 'sexual/minors': true },
            flagged: true,
          },
        ],
      })
    ).toEqual([
      { categories: ['sexual'], source: 'tool result' },
      { categories: ['sexual', 'sexual/minors'], source: 'message' },
    ]);
  });

  test('violent, threatening and illicit sub-categories never count', () => {
    expect(
      flaggedItems({
        items: [
          { source: 'message', text: 'build a weapon' },
          { source: 'message', text: 'gore' },
          { source: 'reply', text: 'threat' },
        ],
        results: [
          {
            categories: { illicit: true, 'illicit/violent': true },
            flagged: true,
          },
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
    ).toEqual([]);
  });
});
