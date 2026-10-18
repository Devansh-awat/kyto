import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '../client';
import { threadLoadedTools } from '../schema/thread-loaded-tools';

export async function getThreadLoadedTools({
  since,
  threadId,
}: {
  since: Date;
  threadId: string;
}): Promise<{ names: string[]; toolOrder: string[] } | undefined> {
  const [row] = await db
    .select({
      names: threadLoadedTools.names,
      toolOrder: threadLoadedTools.toolOrder,
    })
    .from(threadLoadedTools)
    .where(
      and(
        eq(threadLoadedTools.threadId, threadId),
        gte(threadLoadedTools.updatedAt, since)
      )
    );
  return row;
}

export async function saveThreadLoadedTools({
  names,
  threadId,
  toolOrder,
}: {
  names: string[];
  threadId: string;
  toolOrder: string[];
}): Promise<void> {
  await db
    .insert(threadLoadedTools)
    .values({ names, threadId, toolOrder })
    .onConflictDoUpdate({
      set: { names, toolOrder, updatedAt: new Date() },
      target: threadLoadedTools.threadId,
    });
}

export async function deleteStaleThreadLoadedTools(
  before: Date
): Promise<void> {
  await db
    .delete(threadLoadedTools)
    .where(lt(threadLoadedTools.updatedAt, before));
}
