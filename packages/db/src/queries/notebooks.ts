import { eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import { notebooks } from '../schema';

/** The named notebooks' contents, keyed by scope; a missing one is absent. */
export async function getNotebooks(
  scopes: string[]
): Promise<Map<string, string>> {
  if (scopes.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ content: notebooks.content, scope: notebooks.scope })
    .from(notebooks)
    .where(inArray(notebooks.scope, scopes));
  return new Map(rows.map((row) => [row.scope, row.content]));
}

export async function saveNotebook({
  content,
  scope,
}: {
  content: string;
  scope: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(notebooks)
    .values({ content, scope, updatedAt: now })
    .onConflictDoUpdate({
      set: { content, updatedAt: now },
      target: notebooks.scope,
    });
}

/** Returns whether there was one to delete. */
export async function deleteNotebook(scope: string): Promise<boolean> {
  const rows = await db
    .delete(notebooks)
    .where(eq(notebooks.scope, scope))
    .returning({ scope: notebooks.scope });
  return rows.length > 0;
}
