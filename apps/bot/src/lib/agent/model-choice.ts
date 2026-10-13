import { createHash } from 'node:crypto';
import {
  catalogAttempt,
  GLM_FLASH_MODEL,
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
import type { SHARED_MODEL_NAMES } from '@/lib/flags';
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

// Keyed by lib/flags' names, so a flag ending a line knows them without
// importing this module's provider chain.
export const MODEL_CHOICES: Record<string, ModelAttempt> = {
  haiku: PRIMARY_ATTEMPT,
  glm: catalogAttempt(GLM_FLASH_MODEL),
  luna: catalogAttempt(LUNA_MODEL),
} satisfies Record<(typeof SHARED_MODEL_NAMES)[number], ModelAttempt>;

/**
 * The model experiment (owner's call 2026-10-11): a thread with no `--model`
 * leads with haiku or luna, half of threads each, so the two can be compared on
 * the same traffic. Drawn per THREAD, not per turn — each model has its own
 * prompt cache, and switching models between turns would rewrite the whole
 * thread at 1.25x every time. Derived from the thread id, so it survives a
 * restart without being stored.
 */
export function experimentAttempt(threadId: string): ModelAttempt {
  const firstByte = createHash('sha256').update(threadId).digest()[0] ?? 0;
  return firstByte % 2 === 0
    ? PRIMARY_ATTEMPT
    : (MODEL_CHOICES.luna ?? PRIMARY_ATTEMPT);
}

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// `--no-memory` / `--NO-MEMORY` (lib/flags), kept with the model choice so it
// is sticky the same way: flipping memories per message would change the
// cached system prompt on every turn.
export type MemoryMode = 'off' | 'stale';

export interface ThreadModelChoice {
  effort?: ReasoningEffort;
  memory?: MemoryMode;
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
          memory:
            row.memoryMode === 'off' || row.memoryMode === 'stale'
              ? row.memoryMode
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
  change: {
    effort?: ReasoningEffort | null;
    memory?: MemoryMode | null;
    model?: string | null;
  };
  threadId: string;
  userId: string;
}): Promise<void> {
  const map = await choices();
  const current = map.get(threadId) ?? {};
  const next: ThreadModelChoice = { ...current };
  if (change.effort !== undefined) {
    next.effort = change.effort ?? undefined;
  }
  if (change.memory !== undefined) {
    next.memory = change.memory ?? undefined;
  }
  if (change.model !== undefined) {
    next.model = change.model ?? undefined;
    next.modelSetBy = change.model ? userId : undefined;
  }
  await saveThreadModelChoice({
    memoryMode: next.memory ?? null,
    model: next.model ?? null,
    modelSetBy: next.modelSetBy ?? null,
    reasoningEffort: next.effort ?? null,
    threadId,
    updatedBy: userId,
  });
  map.set(threadId, next);
}
