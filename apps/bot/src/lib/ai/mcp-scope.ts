import type { SharedMcpServer, UserMcpServer } from '@repo/db/queries';

/**
 * One MCP server as it will be exposed on a single turn.
 *
 * `namespace` — not `server.name` — is what the tool names are built from,
 * because two people can each have a server called `github` and both can be in
 * scope in the same channel. Getting that wrong would route a call meant for one
 * person's credential at another's, so it is resolved here, deterministically,
 * with tests.
 */
export interface McpServerForTurn {
  namespace: string;
  server: UserMcpServer;
  /** Set when the server is in scope because someone shared it into the room. */
  sharedBy?: string;
}

function suffixed(name: string, index: number): string {
  return index === 0 ? name : `${name}_${index + 1}`;
}

/**
 * Decide which MCP servers a turn can see, and what each one's tools are called.
 *
 * Three rules, in this order:
 *
 * 1. **The asker's own servers come first and keep their own names.** Someone
 *    who has used `mcp_github_*` in a DM must get the same tool, under the same
 *    name, in a channel where a colleague has also shared a `github` server.
 * 2. **A server is listed once.** Sharing your own server into a channel and
 *    then using kyto there must not produce two copies of every tool.
 * 3. **A collision is resolved by suffix, in a STABLE order** (own first, then
 *    by name, then by row id — never by insertion order or by `Promise.all`
 *    completion). Stability is not cosmetic here: tool schemas serialize before
 *    the messages, so a set that reshuffles between turns throws away the
 *    prompt cache for the whole thread (see stabilizeToolOrder).
 */
export function resolveTurnMcpServers({
  own,
  shared,
}: {
  own: UserMcpServer[];
  shared: SharedMcpServer[];
}): McpServerForTurn[] {
  const ordered = [
    ...[...own]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((server) => ({ server, sharedBy: undefined as string | undefined })),
    ...[...shared]
      .sort(
        (a, b) =>
          a.server.name.localeCompare(b.server.name) ||
          a.server.id.localeCompare(b.server.id)
      )
      .map((entry) => ({
        server: entry.server,
        sharedBy: entry.share.sharedBy,
      })),
  ];
  const seen = new Set<string>();
  const used = new Set<string>();
  const resolved: McpServerForTurn[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.server.id)) {
      continue;
    }
    seen.add(entry.server.id);
    let index = 0;
    while (used.has(suffixed(entry.server.name, index))) {
      index += 1;
    }
    const namespace = suffixed(entry.server.name, index);
    used.add(namespace);
    resolved.push({
      namespace,
      server: entry.server,
      ...(entry.sharedBy ? { sharedBy: entry.sharedBy } : {}),
    });
  }
  return resolved;
}
