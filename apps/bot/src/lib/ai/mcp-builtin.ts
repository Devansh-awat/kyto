import type { UserMcpServer } from '@repo/db/queries';
import { env } from '@/env';
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

/** Its results go through the email redaction (see lib/ai/mcp.ts). */
export const AGENTMAIL_BUILTIN_ID = 'builtin:agentmail';

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

// AgentMail's own MCP on kyto's inbox (owner's ask, 2026-09-29): threads,
// search, drafts and labels beyond kyto's four email tools. Same openness as
// those tools — reading and sending are for everyone — and NOTHING more:
// - every result passes lib/email/redact, exactly like readEmail, because the
//   "trigger a reset to kyto's address, then have it read out" attack does not
//   care which tool reads the mail;
// - `forward_message` stays hidden: it forwards the ORIGINAL server-side, reset
//   link and all, around the redaction entirely;
// - anything account-shaped (inboxes, deletes, allow/block lists, providers,
//   organizations, `agent_*`) is hidden, since the key is the whole account.
function agentmail(apiKey: string): UserMcpServer {
  return {
    authorization: `Bearer ${apiKey}`,
    createdAt: new Date(0),
    id: AGENTMAIL_BUILTIN_ID,
    name: AGENTMAIL_NAMESPACE,
    rules: {
      read: 'allow',
      sensitive: 'never',
      tools: {
        create_draft: 'allow',
        forward_message: 'never',
        get_attachment: 'never',
        reply_to_message: 'allow',
        send_draft: 'allow',
        send_message: 'allow',
        update_draft: 'allow',
        update_message: 'allow',
        update_thread: 'allow',
      },
      unknown: 'never',
      write: 'never',
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
