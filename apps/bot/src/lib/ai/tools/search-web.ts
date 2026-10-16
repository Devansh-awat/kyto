import { tool } from 'ai';
import Exa from 'exa-js';
import { z } from 'zod';

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const URL_IN_QUERY = /https?:\/\/\S+/i;
// `site:docs.python.org asyncio` searches a site; `site:example.com/some/page`
// is after one page.
const SITE_WITH_PATH = /\bsite:([^\s/]+)\/\S+/i;

export function searchWebTool({ apiKey }: { apiKey: string }) {
  const exa = new Exa(apiKey);
  return tool({
    description:
      'Search the web for current information, documentation, news, and facts, rather than guessing or answering from training. Search the distinctive term, not a whole question. NOT for reading a page whose URL you have or can tell (fetchUrl reads it whole; snippets are fragments), and not for the inside of a git repo (clone it in the sandbox).',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(500)
        .describe("A specific, clear web search query for what you're after."),
      numResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS)
        .optional()
        .describe(
          `How many results (default ${DEFAULT_RESULTS}). More for a broad survey, fewer for one fact.`
        ),
    }),
    execute: async ({ numResults = DEFAULT_RESULTS, query }) => {
      // Searching a URL returns pages ABOUT it at best; the model then
      // answered from snippets instead of reading the page it already had.
      const url = URL_IN_QUERY.exec(query)?.[0];
      const site = SITE_WITH_PATH.exec(query);
      if (url || site) {
        return {
          error: `Not searched: this query is after one specific page. Read it directly with fetchUrl (${url ?? site?.[0].replace(/^site:/i, 'https://')}). To search across a whole site, use site:<domain> without a path.`,
          resultCount: 0,
        };
      }
      const { results } = await exa.search(query, {
        type: 'auto',
        numResults,
        contents: { text: { maxCharacters: 1200 } },
      });
      const links = results.slice(0, 5).map((result) => result.url);
      return {
        links,
        resultCount: results.length,
        results: results.map((result) => ({
          title: result.title ?? result.url,
          url: result.url,
          text: result.text ?? '',
          publishedDate: result.publishedDate,
        })),
        summary:
          results.length === 0
            ? `Search web found no results for "${query}". Try other words: the bare distinctive term, another spelling, a synonym.`
            : `Search web found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}". Top links: ${links.join(', ')}. These are leads: fetchUrl the best ones before relying on a snippet.`,
      };
    },
  });
}
