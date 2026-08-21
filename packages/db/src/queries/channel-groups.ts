import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import {
  type ChannelGroup,
  channelGroupChannels,
  channelGroups,
} from '../schema/channel-groups';

export type { ChannelGroup } from '../schema/channel-groups';

/** A group plus the channels currently in it. */
export interface ChannelGroupWithChannels extends ChannelGroup {
  channelIds: string[];
}

/**
 * Names are matched case-insensitively and stored lower-cased, so `HQ` and `hq`
 * cannot become two groups that look identical in a channel list.
 */
export function normalizeGroupName(name: string): string {
  return name.trim().toLowerCase();
}

async function attachChannels(
  groups: ChannelGroup[]
): Promise<ChannelGroupWithChannels[]> {
  if (groups.length === 0) {
    return [];
  }
  const rows = await db
    .select()
    .from(channelGroupChannels)
    .where(
      inArray(
        channelGroupChannels.groupId,
        groups.map((group) => group.id)
      )
    )
    .orderBy(asc(channelGroupChannels.addedAt));
  const byGroup = new Map<string, string[]>();
  for (const row of rows) {
    const list = byGroup.get(row.groupId) ?? [];
    list.push(row.channelId);
    byGroup.set(row.groupId, list);
  }
  return groups.map((group) => ({
    ...group,
    channelIds: byGroup.get(group.id) ?? [],
  }));
}

export async function listChannelGroups(): Promise<ChannelGroupWithChannels[]> {
  const groups = await db
    .select()
    .from(channelGroups)
    .orderBy(asc(channelGroups.name));
  return await attachChannels(groups);
}

export async function getChannelGroup(
  id: string
): Promise<ChannelGroupWithChannels | undefined> {
  const [group] = await db
    .select()
    .from(channelGroups)
    .where(eq(channelGroups.id, id))
    .limit(1);
  if (!group) {
    return;
  }
  const [withChannels] = await attachChannels([group]);
  return withChannels;
}

export async function getChannelGroupByName(
  name: string
): Promise<ChannelGroup | undefined> {
  const [group] = await db
    .select()
    .from(channelGroups)
    .where(eq(channelGroups.name, normalizeGroupName(name)))
    .limit(1);
  return group;
}

/**
 * The groups a channel belongs to. This is the hot path — it runs once per turn
 * to resolve which shared MCP servers and promoted memories are in scope — so it
 * is a single indexed lookup, not a walk of every group.
 */
export async function listGroupIdsForChannel(
  channelId: string
): Promise<string[]> {
  const rows = await db
    .select({ groupId: channelGroupChannels.groupId })
    .from(channelGroupChannels)
    .where(eq(channelGroupChannels.channelId, channelId));
  return rows.map((row) => row.groupId);
}

export async function createChannelGroup(input: {
  createdBy: string;
  name: string;
}): Promise<ChannelGroup | undefined> {
  const [row] = await db
    .insert(channelGroups)
    .values({
      createdBy: input.createdBy,
      name: normalizeGroupName(input.name),
    })
    .onConflictDoNothing({ target: channelGroups.name })
    .returning();
  return row;
}

export async function renameChannelGroup(input: {
  id: string;
  name: string;
}): Promise<void> {
  await db
    .update(channelGroups)
    .set({ name: normalizeGroupName(input.name) })
    .where(eq(channelGroups.id, input.id));
}

/**
 * Replace a group's channel list wholesale. The caller has already checked that
 * this user is the group's custodian — this layer has no notion of who is
 * asking, exactly like setMemoryGlobal.
 */
export async function setChannelGroupChannels(input: {
  addedBy: string;
  channelIds: string[];
  groupId: string;
}): Promise<void> {
  const wanted = [...new Set(input.channelIds)].filter(Boolean);
  await db
    .delete(channelGroupChannels)
    .where(eq(channelGroupChannels.groupId, input.groupId));
  if (wanted.length === 0) {
    return;
  }
  await db.insert(channelGroupChannels).values(
    wanted.map((channelId) => ({
      addedBy: input.addedBy,
      channelId,
      groupId: input.groupId,
    }))
  );
}

export async function deleteChannelGroup(id: string): Promise<void> {
  await db
    .delete(channelGroupChannels)
    .where(eq(channelGroupChannels.groupId, id));
  await db.delete(channelGroups).where(eq(channelGroups.id, id));
}
