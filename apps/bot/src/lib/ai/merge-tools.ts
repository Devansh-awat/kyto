import { type Tool, tool } from 'ai';
import { z } from 'zod';

/**
 * One tool per FAMILY (memory, reminders, canvas, …) with an `action` field,
 * instead of one tool per verb.
 *
 * kyto saw ~80 tool names and the same few patterns again and again (save /
 * fetch / edit / delete); every name is something the model has to keep apart
 * and every schema rides in the prompt. Each action is still its ORIGINAL tool:
 * its own schema validates the input and its own execute runs, so nothing about
 * what a verb does changes.
 *
 * The schema is FLAT (`action` plus every field, all optional), not a union:
 * OpenAI rejects a function whose parameters aren't a top-level object, and a
 * union's per-action requirements are checked here anyway. A field can't be
 * marked required for ONE action in a flat schema, so the requirement is said
 * in words instead: each action's line in the description lists the fields it
 * needs, a field's description says which actions need it, and a call missing
 * one is told exactly what to add. Said nowhere, GLM sent `memory edit` with
 * only a body ~15 times in one turn, 5 KB each (#184).
 *
 * Pass tools that are ALREADY wrapped (trackUse): usage, the anti-coding guard,
 * the Slack budget and redaction all key on the original names, which are only
 * still visible at that level.
 */
export function mergeTools({
  actions,
  description,
}: {
  actions: Record<string, Tool>;
  description: string;
}): Tool {
  const names = Object.keys(actions);
  const [first, ...rest] = names;
  if (!first) {
    throw new Error('mergeTools needs at least one action.');
  }
  const schemas = new Map<string, z.ZodObject>();
  const fieldActions = new Map<string, string[]>();
  const fieldSchemas = new Map<string, z.ZodType[]>();
  const requiredBy = new Map<string, string[]>();
  const required = new Map<string, string[]>();
  for (const name of names) {
    const schema = actions[name]?.inputSchema;
    if (!(schema instanceof z.ZodObject)) {
      throw new Error(`mergeTools: action '${name}' has no object schema.`);
    }
    schemas.set(name, schema);
    for (const [field, fieldSchema] of Object.entries(schema.shape)) {
      fieldActions.set(field, [...(fieldActions.get(field) ?? []), name]);
      fieldSchemas.set(field, [
        ...(fieldSchemas.get(field) ?? []),
        fieldSchema as z.ZodType,
      ]);
      if (!(fieldSchema as z.ZodType).safeParse(undefined).success) {
        requiredBy.set(field, [...(requiredBy.get(field) ?? []), name]);
        required.set(name, [...(required.get(name) ?? []), field]);
      }
    }
  }
  const shape: Record<string, z.ZodType> = {
    action: z.enum([first, ...rest]),
  };
  for (const [field, variants] of fieldSchemas) {
    const used = fieldActions.get(field) ?? [];
    const [only, ...others] = variants;
    if (!only) {
      continue;
    }
    // Same field, different types across actions: accept any of them here; the
    // action's own schema decides below.
    const merged = others.length > 0 ? z.union([only, ...others]) : only;
    const base = merged.description ?? only.description ?? '';
    const scope = used.length === names.length ? '' : ` [${used.join(', ')}]`;
    const needed = requiredBy.get(field);
    const must = needed ? ` REQUIRED for ${needed.join(', ')}.` : '';
    shape[field] = merged.optional().describe(`${base}${scope}${must}`.trim());
  }
  return tool({
    description: `${description}\n\nSet \`action\` to one of these, and pass only the fields it uses:\n${names
      .map((name) => {
        const needs = required.get(name);
        const line = needs ? ` (needs ${needs.join(', ')})` : '';
        return `- ${name}${line}: ${actions[name]?.description ?? ''}`;
      })
      .join('\n')}`,
    inputSchema: z.object(shape),
    execute: async (input: Record<string, unknown>, options) => {
      const { action, ...fields } = input;
      const name = typeof action === 'string' ? action : '';
      const target = actions[name];
      const schema = schemas.get(name);
      if (!(target?.execute && schema)) {
        return {
          error: `Unknown action '${name}'. Use one of: ${names.join(', ')}.`,
          success: false,
        };
      }
      const parsed = schema.safeParse(fields);
      if (!parsed.success) {
        const missing = (required.get(name) ?? []).filter(
          (field) => fields[field] === undefined || fields[field] === null
        );
        return {
          error: missing.length
            ? `Action '${name}' needs ${missing.map((field) => `\`${field}\``).join(' and ')}, which this call left out. Call again WITH ${missing.length > 1 ? 'them' : 'it'}; the same call without ${missing.length > 1 ? 'them' : 'it'} fails the same way.`
            : `Invalid input for action '${name}': ${z.prettifyError(parsed.error)}. Fix that field and call again; the same call fails the same way.`,
          success: false,
        };
      }
      return await target.execute(parsed.data, options);
    },
  });
}

/**
 * The families: merged name → action → the original tool's name. Originals keep
 * their names underneath (usage logs, CODE_TOOLS, the plan's renderers); only
 * the model sees the family.
 */
export const TOOL_FAMILIES = {
  canvas: {
    actions: {
      delete: 'canvasDelete',
      list: 'canvasList',
      read: 'canvasRead',
      write: 'canvasWrite',
    },
    description: 'Slack canvases: read, create/edit, list, delete.',
    summary: 'Slack canvases: read, create/edit, list or delete',
  },
  email: {
    actions: {
      inbox: 'checkInbox',
      read: 'readEmail',
      reply: 'replyEmail',
      send: 'sendEmail',
    },
    description: "kyto's own email inbox.",
    summary: "kyto's email inbox: check, read, send, reply",
  },
  embed: {
    actions: { post: 'embed', remove: 'removeEmbed' },
    description:
      'Live interactive pages inside a Slack message (custom HTML or a whiteboard).',
    summary:
      'post a LIVE interactive page (custom HTML, or a whiteboard) inside a Slack message, or remove one',
  },
  followThread: {
    actions: { join: 'joinThread', leave: 'leaveThread' },
    description:
      'Follow (answer every reply in) or stop following a Slack thread.',
    summary: 'follow or stop following this thread',
  },
  memory: {
    actions: {
      attach: 'attachMemoryFiles',
      delete: 'deleteMemory',
      detach: 'detachMemoryFiles',
      edit: 'editMemory',
      fetch: 'fetchMemory',
      files: 'restoreMemoryFiles',
      restore: 'restoreMemory',
      save: 'saveMemory',
    },
    description:
      'Your long-term memories (facts, preferences, decisions), optionally with a folder of files attached.',
    summary:
      'long-term memories: save, fetch, edit, delete, restore; attach / unpack (files) / detach a folder of files',
  },
  pins: {
    actions: { pin: 'pinMessage', unpin: 'unpinMessage' },
    description: 'Pin or unpin a Slack message.',
    summary: 'pin or unpin a message',
  },
  process: {
    actions: {
      kill: 'killProcess',
      output: 'getProcessOutput',
      start: 'runBackgroundProcess',
    },
    description:
      'Long-running shell commands in the background of the sandbox.',
    summary: 'background shell commands: start, read output/status, kill',
  },
  reaction: {
    actions: { add: 'react', remove: 'unreact' },
    description: 'Add or remove your emoji reaction on a Slack message.',
    summary: 'add or remove an emoji reaction',
  },
  reminders: {
    actions: {
      cancel: 'cancelReminder',
      edit: 'editReminder',
      list: 'listReminders',
      on_event: 'scheduleEventReminder',
      once: 'scheduleReminder',
      pause: 'pauseReminder',
      recurring: 'scheduleRecurringReminder',
      resume: 'resumeReminder',
    },
    description:
      'Reminders and scheduled jobs: a one-time DM reminder, a recurring message / URL fetch / bash command / headless agent run, or one that fires on an event (a Slack message or reaction, a webhook, a GitHub webhook).',
    summary:
      'reminders and scheduled jobs: one-time, recurring (interval, daily, weekly, cron), on an event (Slack message/reaction, webhook, GitHub), list, edit, pause, resume, cancel',
  },
  sites: {
    actions: {
      deploy: 'deploySite',
      list: 'listSites',
      remove: 'removeSite',
      stats: 'siteStats',
    },
    description: 'Static websites kyto hosts at a public URL.',
    summary: 'publish, list or take down a static website, or see its views',
  },
  subagent: {
    actions: { check: 'checkSubagent', run: 'runSubagent' },
    description:
      'Headless helper copies of you that take a task and report back.',
    summary: 'delegate a task to a subagent, or check a background one',
  },
} as const;

/** Original tool name → its family's name. */
export const FAMILY_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(TOOL_FAMILIES).flatMap(([family, entry]) =>
    Object.values(entry.actions).map((original) => [original, family])
  )
);

/** The original tool a family call stands for, for logs and the plan UI. */
export function originalToolName({
  input,
  toolName,
}: {
  input: unknown;
  toolName: string;
}): string {
  const actions = ACTIONS_OF.get(toolName);
  const action =
    input && typeof input === 'object' && 'action' in input
      ? String(input.action)
      : '';
  return actions?.get(action) ?? toolName;
}

const ACTIONS_OF: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  Object.entries(TOOL_FAMILIES).map(([family, entry]) => [
    family,
    new Map(Object.entries(entry.actions)),
  ])
);
