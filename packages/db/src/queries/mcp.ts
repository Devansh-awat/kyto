import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../client';
import type { McpServerShare, UserMcpServer } from '../schema/mcp';
import { mcpServerShares, userMcpServers } from '../schema/mcp';

export type { McpServerShare, UserMcpServer } from '../schema/mcp';

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

export async function getMcpServerById(
  id: string
): Promise<UserMcpServer | undefined> {
  const [row] = await db
    .select()
    .from(userMcpServers)
    .where(eq(userMcpServers.id, id))
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

/** Returns the removed row's id, so the caller can drop its cached failure. */
export async function removeMcpServer(input: {
  name: string;
  userId: string;
}): Promise<string | undefined> {
  const [row] = await db
    .select({ id: userMcpServers.id })
    .from(userMcpServers)
    .where(
      and(
        eq(userMcpServers.userId, input.userId),
        eq(userMcpServers.name, input.name)
      )
    )
    .limit(1);
  if (!row) {
    return;
  }
  // Shares first. There is no FK cascade in this schema, and a share left
  // pointing at a deleted server would be an entry in a channel's tool list that
  // nobody can see, edit or revoke — deleting the server is exactly how someone
  // takes their credential back out of a room.
  await db.delete(mcpServerShares).where(eq(mcpServerShares.serverId, row.id));
  await db.delete(userMcpServers).where(eq(userMcpServers.id, row.id));
  return row.id;
}

/** A shared server, plus the share row that put it in scope for this turn. */
export interface SharedMcpServer {
  server: UserMcpServer;
  share: McpServerShare;
}

/**
 * Every server shared into this channel, directly or through a group the channel
 * belongs to. The caller resolves `groupIds` (listGroupIdsForChannel) and passes
 * them in, so this stays one query.
 *
 * A server the ASKER already owns is not filtered out here — the caller merges
 * and de-duplicates, because it also has to keep the tool namespace stable.
 */
export async function listSharedMcpServers(input: {
  channelId: string;
  groupIds: string[];
}): Promise<SharedMcpServer[]> {
  const scopes = [
    and(
      eq(mcpServerShares.scopeKind, 'channel'),
      eq(mcpServerShares.scopeId, input.channelId)
    ),
    ...(input.groupIds.length > 0
      ? [
          and(
            eq(mcpServerShares.scopeKind, 'group'),
            inArray(mcpServerShares.scopeId, input.groupIds)
          ),
        ]
      : []),
  ];
  const rows = await db
    .select({ server: userMcpServers, share: mcpServerShares })
    .from(mcpServerShares)
    .innerJoin(userMcpServers, eq(userMcpServers.id, mcpServerShares.serverId))
    .where(or(...scopes));
  return rows;
}

/** Where one server is currently shared. Drives the share modal's initial state. */
export function listMcpServerShares(
  serverId: string
): Promise<McpServerShare[]> {
  return db
    .select()
    .from(mcpServerShares)
    .where(eq(mcpServerShares.serverId, serverId));
}

/**
 * Replace one server's shares wholesale. The caller has already checked that
 * this user owns the server; `sharedBy` is written from the acting user, never
 * from the form, so a share can always be traced back to a real person.
 */
export async function setMcpServerShares(input: {
  scopes: { scopeId: string; scopeKind: 'channel' | 'group' }[];
  serverId: string;
  sharedBy: string;
}): Promise<void> {
  await db
    .delete(mcpServerShares)
    .where(eq(mcpServerShares.serverId, input.serverId));
  const wanted = input.scopes.filter((scope) => scope.scopeId);
  if (wanted.length === 0) {
    return;
  }
  await db.insert(mcpServerShares).values(
    wanted.map((scope) => ({
      scopeId: scope.scopeId,
      scopeKind: scope.scopeKind,
      serverId: input.serverId,
      sharedBy: input.sharedBy,
    }))
  );
}

/** Drop every share pointing at a group, used when the group is deleted. */
export async function removeMcpSharesForGroup(groupId: string): Promise<void> {
  await db
    .delete(mcpServerShares)
    .where(
      and(
        eq(mcpServerShares.scopeKind, 'group'),
        eq(mcpServerShares.scopeId, groupId)
      )
    );
}
