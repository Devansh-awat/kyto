import { lt } from 'drizzle-orm';
import { db } from '../client';
import {
  type ThreadModelChoiceRow,
  threadModelChoices,
} from '../schema/thread-model-choices';

/** Every live choice; rows untouched for `maxAgeMs` are dropped first. */
export async function loadThreadModelChoices(
  maxAgeMs: number
): Promise<ThreadModelChoiceRow[]> {
  await db
    .delete(threadModelChoices)
    .where(lt(threadModelChoices.updatedAt, new Date(Date.now() - maxAgeMs)));
  return await db.select().from(threadModelChoices);
}

export async function saveThreadModelChoice({
  memoryMode,
  model,
  modelSetBy,
  reasoningEffort,
  threadId,
  updatedBy,
}: {
  memoryMode: string | null;
  model: string | null;
  modelSetBy: string | null;
  reasoningEffort: string | null;
  threadId: string;
  updatedBy: string;
}): Promise<void> {
  await db
    .insert(threadModelChoices)
    .values({
      memoryMode,
      model,
      modelSetBy,
      reasoningEffort,
      threadId,
      updatedBy,
    })
    .onConflictDoUpdate({
      set: {
        memoryMode,
        model,
        modelSetBy,
        reasoningEffort,
        updatedAt: new Date(),
        updatedBy,
      },
      target: threadModelChoices.threadId,
    });
}
