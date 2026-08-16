import { z } from 'zod';

// Per-server permission rules for a user's MCP tools.
//
// An MCP server is a stranger's code holding a real credential: kyto lists
// whatever tools it advertises and hands the model all of them. Coolify's server
// alone ships 45, three of which deploy and restart production. So each server
// carries rules, and every tool it advertises is sorted into a category those
// rules speak about.
//
// Classification is deliberately layered, because servers disagree about how
// much they tell you. The MCP spec has `annotations.readOnlyHint` /
// `destructiveHint` for exactly this and they are the best signal — but Coolify
// sends `annotations: {}` on all 45 tools, so a real server can be fully
// spec-shaped and still say nothing. It DOES state the API ability each tool
// needs in its description ("Requires read:sensitive ability."), which is the
// second layer, and after that only the tool's name is left. Anything still
// unclassified stays `unknown` rather than being guessed into `read` — an
// unfamiliar verb is far more likely to be a write than a read.

export const MCP_CATEGORIES = [
  'read',
  'sensitive',
  'write',
  'unknown',
] as const;
export type McpCategory = (typeof MCP_CATEGORIES)[number];

export const MCP_RULES = ['allow', 'ask', 'never'] as const;
export type McpRule = (typeof MCP_RULES)[number];

export interface McpServerRules {
  read: McpRule;
  sensitive: McpRule;
  /** Per-tool overrides, keyed by the server's OWN tool name (`get_logs`). */
  tools: Record<string, McpRule>;
  unknown: McpRule;
  write: McpRule;
}

/**
 * What a server gets before anyone configures it: reads run, everything that
 * mutates or can return a secret asks first, and a tool kyto could not classify
 * is treated as a write. A server is useful from the first turn without a
 * newly-added one being able to redeploy production unattended.
 */
export const DEFAULT_MCP_RULES: McpServerRules = {
  read: 'allow',
  sensitive: 'ask',
  tools: {},
  unknown: 'ask',
  write: 'ask',
};

// Enough to pin every tool on a large server, low enough that a runaway write
// can't grow the row without bound.
const MAX_TOOL_OVERRIDES = 200;
const MAX_TOOL_NAME = 128;

const ruleSchema = z.enum(MCP_RULES);

const rulesSchema = z.object({
  read: ruleSchema.catch(DEFAULT_MCP_RULES.read),
  sensitive: ruleSchema.catch(DEFAULT_MCP_RULES.sensitive),
  tools: z.record(z.string(), ruleSchema).catch({}),
  unknown: ruleSchema.catch(DEFAULT_MCP_RULES.unknown),
  write: ruleSchema.catch(DEFAULT_MCP_RULES.write),
});

/**
 * Read rules off a `user_mcp_servers` row. The column is free-form jsonb, so it
 * is parsed rather than cast, and a row written by an older build (or by hand)
 * falls back to the defaults field by field instead of failing the turn — the
 * fallback is the SAFE shape, so a corrupt value cannot open a gate.
 */
export function parseMcpRules(value: unknown): McpServerRules {
  if (value === null || value === undefined) {
    return DEFAULT_MCP_RULES;
  }
  const parsed = rulesSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_MCP_RULES;
}

export interface McpToolShape {
  annotations?: Record<string, unknown>;
  description?: string;
  name: string;
}

// "Requires read:sensitive ability." / "requires the `deploy` scope"
const STATED_ABILITY =
  /requires?\s+(?:the\s+)?[`'"]?([a-z][\w:.*-]*)[`'"]?\s+(?:abilit(?:y|ies)|scopes?|permissions?)/i;
const SENSITIVE_ABILITY = /sensitive/i;
const WRITE_ABILITY =
  /^(?:deploy|write|root|admin|manage|owner|delete|full)(?:[:_-]|$)/i;
const READ_ABILITY = /^read(?:[:_-]|$)/i;

const WRITE_NAME =
  /^(?:create|update|delete|remove|destroy|add|set|put|patch|post|write|edit|modify|deploy|redeploy|restart|reboot|start|stop|kill|cancel|control|execute|exec|run|trigger|send|upload|move|rename|clear|reset|revoke|rotate|enable|disable|install|uninstall|apply|purge|sync|import|invite|assign|grant|approve|merge|close|open|publish|unpublish)(?:[_.-]|$)/i;

// Reads that can hand back a credential. Logs and environment variables are the
// two that bite: `get_logs` on Coolify says its output is "best-effort redacted
// (not a guarantee)", which is not a guarantee at all.
const SENSITIVE_NAME =
  /(?:^|[_.-])(?:logs?|secrets?|credentials?|passwords?|envs?|env_vars?|environment|environment_variables?|private_keys?|api_keys?|access_keys?|tokens?|certificates?)(?:$|[_.-])/i;

const READ_NAME =
  /^(?:get|list|read|fetch|search|find|show|describe|query|count|view|check|inspect|lookup|resolve|browse|stat|summarize|export)(?:[_.-]|$)/i;
// Self-describing endpoints that carry no verb at all (`coolify_help`).
const READ_WORD =
  /(?:^|[_.-])(?:help|docs?|documentation|info|about|version|ping|schema|status|capabilities)(?:$|[_.-])/i;

function statedAbility(description: string | undefined): string | undefined {
  return description?.match(STATED_ABILITY)?.[1];
}

/**
 * Sort one advertised tool into a category. Pure, and the only place the layered
 * signal order lives.
 */
export function classifyMcpTool(tool: McpToolShape): McpCategory {
  const annotations = tool.annotations ?? {};
  const readOnly = annotations.readOnlyHint;
  const destructive = annotations.destructiveHint;
  const ability = statedAbility(tool.description);

  // A server that explicitly says "this mutates" is believed immediately.
  if (destructive === true || readOnly === false) {
    return 'write';
  }
  if (ability) {
    if (SENSITIVE_ABILITY.test(ability)) {
      return 'sensitive';
    }
    if (WRITE_ABILITY.test(ability)) {
      return 'write';
    }
  }
  // Name verbs outrank a bare `readOnlyHint: true` for sensitivity only: a
  // read-only tool CAN still be the one that returns the secret.
  if (WRITE_NAME.test(tool.name)) {
    return 'write';
  }
  if (SENSITIVE_NAME.test(tool.name)) {
    return 'sensitive';
  }
  if (readOnly === true || (ability && READ_ABILITY.test(ability))) {
    return 'read';
  }
  if (READ_NAME.test(tool.name) || READ_WORD.test(tool.name)) {
    return 'read';
  }
  return 'unknown';
}

/** The rule that governs one tool: a per-tool pin, else its category's rule. */
export function resolveMcpRule({
  category,
  rules,
  tool,
}: {
  category: McpCategory;
  rules: McpServerRules;
  tool: string;
}): McpRule {
  return rules.tools[tool] ?? rules[category];
}

export const MCP_CATEGORY_LABELS: Record<McpCategory, string> = {
  read: 'Reads',
  sensitive: 'Sensitive reads (logs, env, secrets)',
  unknown: 'Unclassified',
  write: 'Writes (deploy, restart, delete)',
};

export const MCP_RULE_LABELS: Record<McpRule, string> = {
  allow: 'Allow',
  ask: 'Ask me first',
  never: 'Never (hidden from Kyto)',
};

/** One-line summary of a server's rules for the App Home row. */
export function formatMcpRules(rules: McpServerRules): string {
  const categories = MCP_CATEGORIES.map(
    (category) => `${category} ${rules[category]}`
  ).join(' · ');
  const pinned = Object.keys(rules.tools).length;
  return pinned === 0
    ? categories
    : `${categories} · ${pinned} pinned tool${pinned === 1 ? '' : 's'}`;
}

/** Round-trip the per-tool pins into the edit modal's textarea. */
export function formatToolOverrides(rules: McpServerRules): string {
  return Object.entries(rules.tools)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, rule]) => `${tool}: ${rule}`)
    .join('\n');
}

/**
 * Parse the edit modal's per-tool pins. One `tool: rule` per line; `:` optional.
 * A bad line is REPORTED rather than dropped — silently ignoring a mistyped rule
 * would leave someone believing they had blocked it.
 */
export function parseToolOverrides(text: string | undefined): {
  errors: string[];
  tools: Record<string, McpRule>;
} {
  const errors: string[] = [];
  const tools: Record<string, McpRule> = {};
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([\w.-]+)\s*[:=]?\s*(\S+)$/);
    const tool = match?.[1];
    const value = match?.[2];
    if (!(tool && value)) {
      errors.push(`"${line}" — write it as "tool_name: allow".`);
      continue;
    }
    const rule = ruleSchema.safeParse(value.toLowerCase());
    if (!rule.success) {
      errors.push(`"${line}" — rule must be allow, ask or never.`);
      continue;
    }
    if (tool.length > MAX_TOOL_NAME) {
      errors.push(`"${tool.slice(0, 24)}…" — tool name is too long.`);
      continue;
    }
    tools[tool] = rule.data;
  }
  if (Object.keys(tools).length > MAX_TOOL_OVERRIDES) {
    errors.push(`Keep it to ${MAX_TOOL_OVERRIDES} pinned tools or fewer.`);
  }
  return { errors, tools };
}
