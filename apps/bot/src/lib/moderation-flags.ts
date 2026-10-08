import { z } from 'zod';

// A web page or file kyto read is about anything — news about a war is
// "violence" — so a tool result only counts for sexual content, the one
// category that is a ban whatever brought it in.
const TOOL_RESULT_CATEGORIES = /^sexual/;
// Off everywhere (owner's call, 2026-10-03): in its first day every ping was
// one of these on banter — "kick em" (from a channel) read as violence, "noob
// bot" as harassment. Bare `illicit` too (owner's call, 2026-10-08). Only the
// bare categories: `violence/graphic`, `harassment/threatening` and
// `illicit/violent` still alert.
const IGNORED_CATEGORIES = new Set(['violence', 'harassment', 'illicit']);

export const responseSchema = z.object({
  results: z.array(
    z.object({
      categories: z.record(z.string(), z.boolean().nullable()),
      flagged: z.boolean(),
    })
  ),
});

type ModerationSource =
  | 'message'
  | 'custom instructions'
  | 'tool result'
  | 'reply';

export interface ModerationItem {
  source: ModerationSource;
  text: string;
}

export interface ModerationFlag {
  categories: string[];
  source: ModerationSource;
}

/** Pair each input with its result and keep what should reach the owner. */
export function flaggedItems({
  items,
  results,
}: {
  items: ModerationItem[];
  results: z.infer<typeof responseSchema>['results'];
}): ModerationFlag[] {
  const flags: ModerationFlag[] = [];
  for (const [index, item] of items.entries()) {
    const result = results[index];
    if (!result?.flagged) {
      continue;
    }
    const categories = Object.entries(result.categories)
      .filter(
        ([category, hit]) =>
          hit &&
          !IGNORED_CATEGORIES.has(category) &&
          (item.source !== 'tool result' ||
            TOOL_RESULT_CATEGORIES.test(category))
      )
      .map(([category]) => category);
    if (categories.length > 0) {
      flags.push({ categories, source: item.source });
    }
  }
  return flags;
}
