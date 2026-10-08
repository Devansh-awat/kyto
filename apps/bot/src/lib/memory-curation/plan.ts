import { z } from 'zod';

// What the curator model may propose. Everything is re-checked by checkPlan:
// the model's output is a suggestion, never an authority over someone's notes.
export const planSchema = z.object({
  merges: z
    .array(
      z.object({
        absorb: z.array(z.number().int()).min(1),
        keep: z.number().int(),
        reason: z.string().min(1).max(300),
        summary: z.string().min(1).max(200),
      })
    )
    .default([]),
  remove: z
    .array(
      z.object({ id: z.number().int(), reason: z.string().min(1).max(300) })
    )
    .default([]),
});

export type CurationPlan = z.infer<typeof planSchema>;

// A removal is only for something old: a memory saved last week is not stale,
// whatever a model thinks of it.
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// At most this share of someone's memories may be REMOVED in one pass (merges
// keep their content, so they don't count).
const MAX_REMOVE_SHARE = 0.2;

/**
 * The plan, cut down to what is safe to apply: ids that are this author's
 * private memories, each used at most once, removals only of memories older
 * than 30 days and never more than a fifth of them. Anything else is dropped,
 * not "fixed".
 */
export function checkPlan({
  memories,
  now,
  plan,
}: {
  memories: { id: number; updatedAt: Date }[];
  now: Date;
  plan: CurationPlan;
}): CurationPlan {
  const known = new Map(memories.map((memory) => [memory.id, memory]));
  const used = new Set<number>();
  const merges: CurationPlan['merges'] = [];
  for (const merge of plan.merges) {
    const ids = [merge.keep, ...merge.absorb];
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !known.has(id) || used.has(id))
    ) {
      continue;
    }
    for (const id of ids) {
      used.add(id);
    }
    merges.push(merge);
  }
  const maxRemovals = Math.floor(memories.length * MAX_REMOVE_SHARE);
  const remove: CurationPlan['remove'] = [];
  for (const entry of plan.remove) {
    const memory = known.get(entry.id);
    if (
      !memory ||
      used.has(entry.id) ||
      remove.length >= maxRemovals ||
      now.getTime() - memory.updatedAt.getTime() < STALE_AFTER_MS
    ) {
      continue;
    }
    used.add(entry.id);
    remove.push(entry);
  }
  return { merges, remove };
}

/**
 * The merged body: the kept memory's own text, then each absorbed one in full
 * under its title. Written by code, not the model, because the model only sees
 * bodies cut to a preview and would silently drop the rest.
 */
export function mergedBody({
  absorbed,
  kept,
}: {
  absorbed: { body: string; title: string }[];
  kept: { body: string };
}): string {
  return [
    kept.body,
    ...absorbed.map((memory) => `## ${memory.title}\n\n${memory.body}`),
  ].join('\n\n---\n\n');
}
