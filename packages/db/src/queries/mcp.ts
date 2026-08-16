import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import type { UserMcpServer } from '../schema/mcp';
import { userMcpServers } from '../schema/mcp';

export type { UserMcpServer } from '../schema/mcp';

export function listMcpServers(userId: string): Promise<UserMcpServer[]> {
  return db
    .select()
    .from(userMcpServers)
    .where(eq(userMcpServers.userId, userId));
}

export async function getMcpServer(input: {
  name: string;
  userId: string;
}): Promise<UserMcpServer | undefined> {
  const [row] = await db
    .select()
    .from(userMcpServers)
    .where(
      and(
        eq(userMcpServers.userId, input.userId),
        eq(userMcpServers.name, input.name)
      )
    )
    .limit(1);
  return row;
}

export async function addMcpServer(input: {
  authorization?: string;
  name: string;
  /** Opaque here: the column is jsonb and the bot parses it at its boundary. */
  rules?: unknown;
  url: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(userMcpServers)
    .values(input)
    .onConflictDoUpdate({
      set: {
        authorization: input.authorization ?? null,
        rules: input.rules ?? null,
        url: input.url,
      },
      target: [userMcpServers.userId, userMcpServers.name],
    });
}

/**
 * Edit an existing server in place. `authorization` absent means KEEP the stored
 * credential — the edit modal never shows a token back, so a blank field must not
 * be read as "clear it". Clearing is explicit via `clearAuthorization`.
 */
export async function updateMcpServer(input: {
  authorization?: string;
  clearAuthorization?: boolean;
  name: string;
  rules?: unknown;
  url?: string;
  userId: string;
}): Promise<void> {
  const set: Partial<typeof userMcpServers.$inferInsert> = {};
  if (input.url !== undefined) {
    set.url = input.url;
  }
  if (input.rules !== undefined) {
    set.rules = input.rules;
  }
  if (input.clearAuthorization) {
    set.authorization = null;
  } else if (input.authorization !== undefined) {
    set.authorization = input.authorization;
  }
  if (Object.keys(set).length === 0) {
    return;
  }
  await db
    .update(userMcpServers)
    .set(set)
    .where(
      and(
        eq(userMcpServers.userId, input.userId),
        eq(userMcpServers.name, input.name)
      )
    );
}

export async function removeMcpServer(input: {
  name: string;
  userId: string;
}): Promise<void> {
  await db
    .delete(userMcpServers)
    .where(
      and(
        eq(userMcpServers.userId, input.userId),
        eq(userMcpServers.name, input.name)
      )
    );
}
