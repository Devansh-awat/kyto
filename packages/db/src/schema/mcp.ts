import { jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

// Per-user remote MCP servers, managed from the App Home tab. Each user's
// servers are connected lazily per turn and their tools exposed (namespaced)
// only on that user's turns. Only HTTP(S) transports are possible — Slack
// gives the bot no channel to a server on the user's own machine.
export const userMcpServers = pgTable(
  'user_mcp_servers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull(),
    // Short handle used to namespace tools: `mcp_<name>_<tool>`.
    name: text('name').notNull(),
    url: text('url').notNull(),
    // Optional Authorization header value (e.g. "Bearer xyz"), stored as-is.
    authorization: text('authorization'),
    // Per-server permission rules: which categories of tool may run, ask first,
    // or stay hidden, plus per-tool pins. Deliberately untyped here so the bot
    // parses it with Zod at the boundary (`lib/ai/mcp-permissions`) — the fallback
    // for an unreadable value is the SAFE shape, not an open gate. Null means
    // "never configured", which reads as the defaults.
    rules: jsonb('rules'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('user_mcp_servers_user_name').on(table.userId, table.name)]
);

export type UserMcpServer = typeof userMcpServers.$inferSelect;

// Where a server has been SHARED beyond the person who added it: a channel, or
// a channel group. Owner's call (2026-08-21) — "anyone shares own".
//
// The credential is NOT copied. A share points at the `user_mcp_servers` row,
// so the sharer keeps one place to rotate the token and one place to revoke,
// and the server's own permission rules (the `rules` column) keep applying —
// the person who put it in is the one who decided which of its tools may run
// outright and which have to ask. What a share DOES change is who those tools
// answer for: on a shared server, the person whose turn it is is the approver
// for an `ask`, not the person who shared it (also the owner's call — "person b
// can also approve it"). So sharing a server is handing its capability to the
// room, on purpose; the UI says exactly that.
export const mcpServerShares = pgTable(
  'mcp_server_shares',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // The shared `user_mcp_servers` row. Deleting the server must delete its
    // shares (removeMcpServer does this explicitly — there is no FK cascade,
    // because the rest of this schema does not use FKs either).
    serverId: text('server_id').notNull(),
    // Who shared it. Only they (and the bot owner) may unshare it, and it is
    // their credential the shared tools run on.
    sharedBy: text('shared_by').notNull(),
    // 'channel' | 'group'. Kept as text and parsed at the boundary, like every
    // other open-ended column here.
    scopeKind: text('scope_kind').notNull(),
    // A Slack channel id, or a `channel_groups.id`.
    scopeId: text('scope_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mcp_server_shares_unique').on(
      table.serverId,
      table.scopeKind,
      table.scopeId
    ),
  ]
);

export type McpServerShare = typeof mcpServerShares.$inferSelect;
