import { z } from 'zod';

// Only NSFW alerts the owner (owner's call, 2026-11-03). Every other category
// pinged on banter or ordinary asks: "kick em" read as violence, "noob bot" as
// harassment, a plain request as `illicit/violent` — so the owner was pulled
// into threads for nothing. `sexual` and `sexual/minors` are the categories that
// are a ban whatever brought them in, a tool result included.
const ALERT_CATEGORIES = /^sexual/;

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
      .filter(([category, hit]) => hit && ALERT_CATEGORIES.test(category))
      .map(([category]) => category);
    if (categories.length > 0) {
      flags.push({ categories, source: item.source });
    }
  }
  return flags;
}
