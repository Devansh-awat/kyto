import {
  catalogAttempt,
  LUNA_MODEL,
  type ModelAttempt,
  PRIMARY_ATTEMPT,
  REASONING_EFFORTS,
} from '@repo/ai';
import { getChatgptAccount, listUserModelCredentials } from '@repo/db/queries';
import {
  loadThreadModelChoices,
  saveThreadModelChoice,
} from '@repo/db/queries/thread-model-choices';
import { byokConfigured } from '@/lib/byok/crypto';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// `--model <name>` and `--reasoning <effort>` (owner's asks 2026-10-10): a
// thread's own model and effort, sticky until cleared, open to anyone in the
// thread. `luna`/`haiku` run on kyto's chain; any other slug is accepted only
// from someone with their own key or ChatGPT account, and runs on THAT
// person's turns only — the next speaker never pays for someone else's pick.
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
  modelSetBy?: string;
}

export function isSharedModel(name: string): boolean {
  return Object.hasOwn(MODEL_CHOICES, name);
}

/** May this person pick an arbitrary slug — do they have a model of their own? */
export async function hasOwnModels(userId: string): Promise<boolean> {
  if (!byokConfigured()) {
    return false;
  }
  const [keys, chatgpt] = await Promise.all([
    listUserModelCredentials(userId),
    getChatgptAccount(userId),
  ]);
  return keys.length > 0 || chatgpt !== undefined;
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
          model: row.model ?? undefined,
          modelSetBy: row.modelSetBy ?? undefined,
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

/** Change part of the choice (`null` clears it); the rest is kept. */
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
  const next: ThreadModelChoice = { ...current };
  if (change.effort !== undefined) {
    next.effort = change.effort ?? undefined;
  }
  if (change.model !== undefined) {
    next.model = change.model ?? undefined;
    next.modelSetBy = change.model ? userId : undefined;
  }
  await saveThreadModelChoice({
    model: next.model ?? null,
    modelSetBy: next.modelSetBy ?? null,
    reasoningEffort: next.effort ?? null,
    threadId,
    updatedBy: userId,
  });
  map.set(threadId, next);
}
