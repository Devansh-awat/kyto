import { randomUUID } from 'node:crypto';
import type { ThreadHandle } from '@/harness';
import { mrkdwn, plainText } from '@/harness/views';
import type { McpToolGate } from '@/lib/ai/mcp';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// The in-thread permission prompt for one MCP tool call.
//
// Shaped after lib/confirm-post: the tool BLOCKS on a real click and reports the
// true outcome, so the model says "you declined" rather than a hopeful "sent".
// Deliberately different in one way — there is NO DM fallback. A permission
// prompt only makes sense beside the call that triggered it, and if kyto cannot
// post an ephemeral into this thread then there is nobody to ask, which must fail
// closed rather than quietly proceed.

export const MCP_ALLOW_ONCE_ACTION = 'mcp_permission_allow_once';
export const MCP_DENY_ACTION = 'mcp_permission_deny';
export const MCP_ALLOW_ALWAYS_ACTION = 'mcp_permission_allow_always';
export const MCP_DENY_ALWAYS_ACTION = 'mcp_permission_deny_always';

const MCP_PERMISSION_WAIT_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;
const ARGS_PREVIEW_MAX = 400;

/** `pin` persists the decision as a per-tool rule; otherwise it is one call only. */
export interface McpPermissionOutcome {
  decision: 'allow' | 'deny';
  pin: boolean;
}

interface Entry {
  approverUserId: string;
  expiresAt: number;
  gate: McpToolGate;
  settle: (outcome: McpPermissionOutcome | null) => void;
}

const pending = new Map<string, Entry>();

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(id);
      entry.settle(null);
    }
  }
}

/**
 * Read a row WITHOUT claiming it, so a click can be checked against the row's
 * approver before it consumes the row (same reasoning as confirm-post: a stranger
 * must not be able to burn a prompt the real approver still has to answer).
 */
export function peekMcpPermission(
  id: string
): { approverUserId: string; gate: McpToolGate } | undefined {
  sweep();
  const entry = pending.get(id);
  return entry
    ? { approverUserId: entry.approverUserId, gate: entry.gate }
    : undefined;
}

/** Claim a row. Deleting it here is what stops a double-click running twice. */
export function takeMcpPermission(id: string):
  | {
      gate: McpToolGate;
      settle: (outcome: McpPermissionOutcome | null) => void;
    }
  | undefined {
  const entry = pending.get(id);
  if (!entry) {
    return;
  }
  pending.delete(id);
  return { gate: entry.gate, settle: entry.settle };
}

function escapeSlackText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const CATEGORY_REASON: Record<McpToolGate['category'], string> = {
  read: 'a read',
  sensitive: 'a read that can return secrets (logs, env vars)',
  unknown: 'not classifiable — treated as a write',
  write: 'a write: it can change or destroy things',
};

function argsPreview(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return;
  }
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return;
  }
  if (!text || text === '{}') {
    return;
  }
  return text.length > ARGS_PREVIEW_MAX
    ? `${text.slice(0, ARGS_PREVIEW_MAX)}…`
    : text;
}

function promptBlocks({
  args,
  gate,
  id,
}: {
  args: unknown;
  gate: McpToolGate;
  id: string;
}): unknown[] {
  const preview = argsPreview(args);
  const tool = escapeSlackText(gate.tool);
  const server = escapeSlackText(gate.server);
  // A shared server is not the clicker's, so it is not "your" server and they
  // cannot set a standing rule on it — only the person whose credential it runs
  // on can. Saying whose it is is the point: approving a call here spends
  // somebody else's access, and the clicker should know that before they do.
  const shared = gate.sharedBy !== undefined;
  const headline = shared
    ? `:lock: Kyto wants to run \`${tool}\` on the \`${server}\` MCP server <@${gate.sharedBy}> shared with this channel — ${CATEGORY_REASON[gate.category]}. It runs on their credential.`
    : `:lock: Kyto wants to run \`${tool}\` on your \`${server}\` MCP server — ${CATEGORY_REASON[gate.category]}.`;
  return [
    {
      text: mrkdwn(
        `${headline}${preview ? `\n\`\`\`${escapeSlackText(preview)}\`\`\`` : ''}`
      ),
      type: 'section',
    },
    {
      elements: [
        {
          action_id: MCP_ALLOW_ONCE_ACTION,
          style: 'primary',
          text: plainText('Allow once'),
          type: 'button',
          value: id,
        },
        {
          action_id: MCP_DENY_ACTION,
          text: plainText('Deny'),
          type: 'button',
          value: id,
        },
        ...(shared
          ? []
          : [
              {
                action_id: MCP_ALLOW_ALWAYS_ACTION,
                text: plainText('Always allow this tool'),
                type: 'button',
                value: id,
              },
              {
                action_id: MCP_DENY_ALWAYS_ACTION,
                style: 'danger',
                text: plainText('Never allow this tool'),
                type: 'button',
                value: id,
              },
            ]),
      ],
      type: 'actions',
    },
    {
      elements: [
        mrkdwn(
          shared
            ? 'Only the person who shared this server can set a standing rule for it, in their Kyto App Home.'
            : '"Always" and "Never" are saved as a rule for this tool — change them any time in Kyto’s App Home.'
        ),
      ],
      type: 'context',
    },
  ];
}

/**
 * Ask the server's owner whether one call may go ahead, and BLOCK until they
 * answer (or the wait times out / the turn aborts). Returns the outcome as the
 * tool result text, so whatever happens the model reports the truth.
 */
export async function requestMcpPermission({
  abortSignal,
  approverUserId,
  args,
  extendAttemptDeadline,
  gate,
  thread,
}: {
  abortSignal?: AbortSignal;
  approverUserId: string;
  args: unknown;
  extendAttemptDeadline?: (extraMs: number) => void;
  gate: McpToolGate;
  thread: ThreadHandle;
}): Promise<{ allowed: boolean; detail: string }> {
  sweep();
  if (pending.size >= MAX_ENTRIES) {
    const oldest = pending.keys().next().value;
    if (oldest) {
      const entry = pending.get(oldest);
      pending.delete(oldest);
      entry?.settle(null);
    }
  }
  let settle: (outcome: McpPermissionOutcome | null) => void = () => {
    // replaced synchronously below; the noop guards the type only.
  };
  const wait = new Promise<McpPermissionOutcome | null>((resolve) => {
    settle = resolve;
  });
  const id = randomUUID();
  pending.set(id, {
    approverUserId,
    expiresAt: Date.now() + MCP_PERMISSION_WAIT_MS,
    gate,
    settle,
  });

  try {
    await thread.postEphemeral(
      approverUserId,
      gate.sharedBy
        ? `Allow Kyto to run ${gate.tool} on the shared ${gate.server} MCP server?`
        : `Allow Kyto to run ${gate.tool} on your ${gate.server} MCP server?`,
      { blocks: promptBlocks({ args, gate, id }) }
    );
  } catch (error) {
    pending.delete(id);
    logger.warn(
      { ...toLogError(error), server: gate.server, tool: gate.tool },
      '[mcp] could not ask for permission'
    );
    return {
      allowed: false,
      detail: `Not run. \`${gate.tool}\` needs the user's permission and I could not post the request here, so there was nobody to ask. Tell them to run it from a thread I can post in, or to set a rule for it in App Home.`,
    };
  }

  // Same deal as the confirm-post gate and the `wait` tool: tell the attempt
  // watchdog this pause is deliberate, so a slow decision doesn't kill the turn.
  extendAttemptDeadline?.(MCP_PERMISSION_WAIT_MS + 30_000);

  const outcome = await new Promise<McpPermissionOutcome | null>((resolve) => {
    let done = false;
    const finish = (value: McpPermissionOutcome | null) => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      pending.delete(id);
      finish(null);
    }, MCP_PERMISSION_WAIT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      pending.delete(id);
      finish(null);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    wait.then((value) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      finish(value);
    });
  });

  if (!outcome) {
    return {
      allowed: false,
      detail: abortSignal?.aborted
        ? `Not run — interrupted before the user answered the permission request for \`${gate.tool}\`.`
        : `Not run. The permission request for \`${gate.tool}\` on \`${gate.server}\` went unanswered for ${Math.round(
            MCP_PERMISSION_WAIT_MS / 60_000
          )} minutes. Ask them again if it still needs doing.`,
    };
  }
  if (outcome.decision === 'deny') {
    return {
      allowed: false,
      detail: outcome.pin
        ? `Not run. The user set \`${gate.tool}\` on \`${gate.server}\` to NEVER run — it is blocked from now on, so don't try it again.`
        : `Not run. The user declined \`${gate.tool}\` on \`${gate.server}\` this time.`,
    };
  }
  return {
    allowed: true,
    detail: outcome.pin
      ? `Allowed, and saved as a standing rule for ${gate.tool}.`
      : 'Allowed once.',
  };
}

/**
 * Show the outcome in place of the prompt. The prompt is a THREADED ephemeral, so
 * the replacement must carry `thread_ts` from the interaction payload — without
 * it Slack swaps the message for the viewer AND drops a second copy at the channel
 * root (the duplicate-ephemeral bug the confirm-post gate hit).
 */
export async function replaceMcpPrompt(
  raw: unknown,
  text: string
): Promise<void> {
  const payload = raw as
    | { container?: { thread_ts?: string }; response_url?: string }
    | undefined;
  const responseUrl = payload?.response_url;
  if (!responseUrl) {
    return;
  }
  const threadTs = payload?.container?.thread_ts;
  try {
    await fetch(responseUrl, {
      body: JSON.stringify({
        replace_original: true,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  } catch (error) {
    logger.warn(
      toLogError(error),
      '[mcp] failed to update the permission prompt'
    );
  }
}
