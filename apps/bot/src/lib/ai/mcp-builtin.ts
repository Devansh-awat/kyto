import type { UserMcpServer } from '@repo/db/queries';
import { env } from '@/env';
import { AGENTMAIL_BUILTIN_ID } from '@/lib/ai/mcp';
import type { McpServerForTurn } from '@/lib/ai/mcp-scope';

// MCP servers kyto brings for EVERYONE, without anyone adding them in App Home.
//
// Context7 (owner's ask, 2026-09-29, after seeing coolton ship it built in):
// current library/framework documentation, so an answer about a library is read
// from its docs rather than from whatever the model half-remembers. Both of its
// tools are reads, so they are pinned to `allow` and everything else to `never`
// — a server that later grows a write tool must not have it appear unasked for
// on every turn in the workspace.
//
// Anonymous works (rate-limited per IP); CONTEXT7_API_KEY raises the limit.

const CONTEXT7_NAMESPACE = 'context7';
const AGENTMAIL_NAMESPACE = 'agentmail';

function context7(): UserMcpServer {
  return {
    authorization: env.CONTEXT7_API_KEY
      ? `Bearer ${env.CONTEXT7_API_KEY}`
      : null,
    createdAt: new Date(0),
    id: 'builtin:context7',
    name: CONTEXT7_NAMESPACE,
    rules: {
      read: 'allow',
      sensitive: 'never',
      tools: { 'query-docs': 'allow', 'resolve-library-id': 'allow' },
      unknown: 'never',
      write: 'never',
    },
    url: 'https://mcp.context7.com/mcp',
    userId: 'kyto',
  };
}

// AgentMail's own MCP on kyto's inbox: ALL of its tools, for everyone (owner's
// call, 2026-09-29 — "all 38 tools", after being told what that includes).
// Every result still passes lib/email/redact, like readEmail — the email
// invariant covers every read path. What the owner accepted with the rest:
// `forward_message` sends an ORIGINAL email on server-side, so a reset link in
// it goes out unredacted, and the inbox/delete/account tools can reshape or
// wipe kyto's mailbox. Narrow it again here, per tool, if that bites.
function agentmail(apiKey: string): UserMcpServer {
  return {
    authorization: `Bearer ${apiKey}`,
    createdAt: new Date(0),
    id: AGENTMAIL_BUILTIN_ID,
    name: AGENTMAIL_NAMESPACE,
    rules: {
      read: 'allow',
      sensitive: 'allow',
      tools: {},
      unknown: 'allow',
      write: 'allow',
    },
    url: 'https://mcp.agentmail.to/mcp',
    userId: 'kyto',
  };
}

/**
 * The built-ins, appended AFTER the person's own and shared servers so they can
 * never take a name one of those already uses — someone who added their own
 * `context7` keeps it, and the built-in steps aside rather than being suffixed
 * into a second copy of the same tools.
 */
export function withBuiltinMcpServers(
  servers: McpServerForTurn[]
): McpServerForTurn[] {
  const taken = new Set(servers.map((entry) => entry.namespace));
  const builtins: McpServerForTurn[] = [
    { namespace: CONTEXT7_NAMESPACE, server: context7() },
    ...(env.AGENTMAIL_API_KEY
      ? [
          {
            namespace: AGENTMAIL_NAMESPACE,
            server: agentmail(env.AGENTMAIL_API_KEY),
          },
        ]
      : []),
  ];
  return [
    ...servers,
    ...builtins.filter((entry) => !taken.has(entry.namespace)),
  ];
}
