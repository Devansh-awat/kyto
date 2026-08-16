import { getMcpServer, updateMcpServer } from '@repo/db/queries';
import { publishHome } from '@/features/customizations/service';
import type { ActionEvent } from '@/harness';
import { forgetMcpFailure, type McpToolGate } from '@/lib/ai/mcp';
import { type McpRule, parseMcpRules } from '@/lib/ai/mcp-permissions';
import { bot } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  MCP_ALLOW_ALWAYS_ACTION,
  MCP_ALLOW_ONCE_ACTION,
  MCP_DENY_ACTION,
  MCP_DENY_ALWAYS_ACTION,
  peekMcpPermission,
  replaceMcpPrompt,
  takeMcpPermission,
} from '@/lib/mcp-permissions/request';
import { toLogError } from '@/lib/utils/error';

// The buttons on an MCP tool permission prompt. The waiting tool is unblocked
// from here, so every path must settle exactly once — a handler that returns
// early without settling leaves the turn parked until the 10-minute timeout.

const GONE = 'That permission request expired or was already answered.';
const NOT_YOURS = 'This permission request is not yours to decide.';

/**
 * The clicker's right to decide is checked BEFORE the row is claimed, so a
 * stranger's click cannot consume a prompt the real approver still has to answer.
 * The prompt is an ephemeral only that person can see, but a crafted interaction
 * payload could still name the action id — and this button is what stands between
 * a prompt injection and someone's production infrastructure.
 */
function claimIfAllowed(event: ActionEvent) {
  const id = event.value;
  if (!id) {
    return { error: GONE } as const;
  }
  const peeked = peekMcpPermission(id);
  if (!peeked) {
    return { error: GONE } as const;
  }
  if (event.user.userId !== peeked.approverUserId) {
    return { error: NOT_YOURS } as const;
  }
  const claimed = takeMcpPermission(id);
  return claimed ? ({ claimed } as const) : ({ error: GONE } as const);
}

/**
 * Save a standing rule for one tool. Read-modify-write on purpose: the rules blob
 * is re-parsed from the row first, so a pin can't clobber a category rule the user
 * changed in App Home while the prompt was open.
 */
async function pinRule({
  gate,
  rule,
  userId,
}: {
  gate: McpToolGate;
  rule: McpRule;
  userId: string;
}): Promise<boolean> {
  const server = await getMcpServer({ name: gate.server, userId });
  if (!server) {
    return false;
  }
  const rules = parseMcpRules(server.rules);
  await updateMcpServer({
    name: gate.server,
    rules: { ...rules, tools: { ...rules.tools, [gate.tool]: rule } },
    userId,
  });
  // A hidden tool changes the shape of the toolset, and the listing is cached for
  // ten minutes; drop any recorded failure so the next turn re-derives the server
  // from scratch rather than reporting a verdict from before this decision.
  forgetMcpFailure({ name: gate.server, userId });
  return true;
}

function decide({
  action,
  decision,
  pin,
}: {
  action: string;
  decision: 'allow' | 'deny';
  pin: boolean;
}): void {
  bot.onAction(action, async (event) => {
    const outcome = claimIfAllowed(event);
    if (outcome.error) {
      await replaceMcpPrompt(event.raw, outcome.error);
      return;
    }
    const { gate, settle } = outcome.claimed;
    // Settle FIRST: the tool is blocked on this, and a failed database write must
    // not leave the turn hanging for ten minutes.
    settle({ decision, pin });
    let saved = false;
    if (pin) {
      saved = await pinRule({
        gate,
        rule: decision === 'allow' ? 'allow' : 'never',
        userId: event.user.userId,
      }).catch((error: unknown) => {
        logger.warn(
          { ...toLogError(error), server: gate.server, tool: gate.tool },
          '[mcp] failed to save the tool rule'
        );
        return false;
      });
      if (saved) {
        await publishHome({ userId: event.user.userId }).catch(() => undefined);
      }
    }
    logger.info(
      {
        category: gate.category,
        decision,
        pin,
        saved,
        server: gate.server,
        tool: gate.tool,
        userId: event.user.userId,
      },
      '[mcp] permission decided'
    );
    const verb = decision === 'allow' ? 'Allowed' : 'Denied';
    const icon = decision === 'allow' ? ':white_check_mark:' : ':no_entry:';
    await replaceMcpPrompt(
      event.raw,
      `${icon} ${verb} \`${gate.tool}\` on \`${gate.server}\`${outcomeSuffix({ decision, pin, saved })}`
    );
  });
}

/** What the replaced prompt says happened, including a pin that failed to save. */
function outcomeSuffix({
  decision,
  pin,
  saved,
}: {
  decision: 'allow' | 'deny';
  pin: boolean;
  saved: boolean;
}): string {
  if (!pin) {
    return ' this time.';
  }
  if (!saved) {
    return ' this time. (I could not save the standing rule — the server entry is gone.)';
  }
  return decision === 'allow'
    ? ' — and saved: it will run without asking from now on.'
    : ' — and saved: it stays hidden from Kyto from now on.';
}

decide({ action: MCP_ALLOW_ONCE_ACTION, decision: 'allow', pin: false });
decide({ action: MCP_DENY_ACTION, decision: 'deny', pin: false });
decide({ action: MCP_ALLOW_ALWAYS_ACTION, decision: 'allow', pin: true });
decide({ action: MCP_DENY_ALWAYS_ACTION, decision: 'deny', pin: true });
