import {
  catalogAttempt,
  LUNA_MODEL,
  type ModelAttempt,
  PRIMARY_ATTEMPT,
  REASONING_EFFORTS,
} from '@repo/ai';
import {
  loadThreadModelChoices,
  saveThreadModelChoice,
} from '@repo/db/queries/thread-model-choices';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// `!with <model>` and `!reasoning <effort>` (owner's ask 2026-10-10): a thread's
// own model and effort, sticky until cleared, open to anyone in the thread.
//
// Held in memory and loaded once: the turn reads it on the request path, and a
// Postgres round trip per message is exactly the latency the last few changes
// shaved off. Written through to the table so a deploy (every push restarts
// kyto) doesn't silently drop someone's choice mid-thread.

export const MODEL_CHOICES: Record<string, ModelAttempt> = {
  haiku: PRIMARY_ATTEMPT,
  luna: catalogAttempt(LUNA_MODEL),
};

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ThreadModelChoice {
  effort?: ReasoningEffort;
  model?: string;
}

// A choice nobody has touched in a month belongs to a dead thread.
const CHOICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let loaded: Promise<Map<string, ThreadModelChoice>> | undefined;

function choices(): Promise<Map<string, ThreadModelChoice>> {
  loaded ??= loadThreadModelChoices(CHOICE_TTL_MS)
    .then((rows) => {
      const map = new Map<string, ThreadModelChoice>();
      for (const row of rows) {
        map.set(row.threadId, {
          effort: isReasoningEffort(row.reasoningEffort)
            ? row.reasoningEffort
            : undefined,
          model:
            row.model && Object.hasOwn(MODEL_CHOICES, row.model)
              ? row.model
              : undefined,
        });
      }
      return map;
    })
    .catch((error: unknown) => {
      // Not cached: the next turn tries again rather than every thread losing
      // its choice until the next restart.
      loaded = undefined;
      logger.warn(
        toLogError(error),
        '[model-choice] could not load thread choices'
      );
      return new Map<string, ThreadModelChoice>();
    });
  return loaded;
}

export function isReasoningEffort(
  value: string | null | undefined
): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort === value);
}

export async function threadModelChoice(
  threadId: string
): Promise<ThreadModelChoice> {
  return (await choices()).get(threadId) ?? {};
}

/** Set one half of the choice (`null` clears it); the other half is kept. */
export async function updateThreadModelChoice({
  change,
  threadId,
  userId,
}: {
  change: { effort?: ReasoningEffort | null; model?: string | null };
  threadId: string;
  userId: string;
}): Promise<void> {
  const map = await choices();
  const current = map.get(threadId) ?? {};
  const next: ThreadModelChoice = {
    effort:
      change.effort === undefined
        ? current.effort
        : (change.effort ?? undefined),
    model:
      change.model === undefined ? current.model : (change.model ?? undefined),
  };
  await saveThreadModelChoice({
    model: next.model ?? null,
    reasoningEffort: next.effort ?? null,
    threadId,
    updatedBy: userId,
  });
  map.set(threadId, next);
}
