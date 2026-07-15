import { createMemory, getMemory, updateMemory } from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Guardrails on a single memory. The body rides back into the system prompt only
// when fetched, so it can be large, but not unbounded.
const TITLE_MAX = 120;
const SUMMARY_MAX = 200;
const BODY_MAX = 100_000;

export function saveMemoryTool({ authorUserId }: { authorUserId: string }) {
  return tool({
    description:
      "Save a durable, workspace-global memory after you solve a big or non-obvious task, so a LATER thread can reuse it instead of figuring it out again (e.g. how a tricky site/captcha decodes, a working script, a hard-won fact). Every memory's title + summary is shown to you at the start of every turn; fetch the full body with fetchMemory when relevant. Memories are shared across everyone. Titles are unique — if one already exists, use editMemory instead. Memories can never be deleted, so only save things genuinely worth keeping.",
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(TITLE_MAX)
        .describe('Short unique handle, shown to you every turn.'),
      summary: z
        .string()
        .min(1)
        .max(SUMMARY_MAX)
        .describe('One line describing what is inside, shown every turn.'),
      body: z
        .string()
        .min(1)
        .max(BODY_MAX)
        .describe('The full memory content, fetched on demand.'),
    }),
    execute: async ({ title, summary, body }) => {
      const trimmedTitle = title.trim();
      try {
        const row = await createMemory({
          body,
          createdBy: authorUserId,
          summary: summary.trim(),
          title: trimmedTitle,
        });
        if (!row) {
          return {
            saved: false,
            summary: `A memory titled "${trimmedTitle}" already exists. Use editMemory to change it, or pick a different title.`,
          };
        }
        logger.info(
          { title: trimmedTitle, userId: authorUserId },
          '[memory] saved'
        );
        return {
          saved: true,
          summary: `Saved memory "${trimmedTitle}". It will be listed to you at the start of future turns.`,
        };
      } catch (error) {
        return { error: errorMessage(error), saved: false };
      }
    },
  });
}

export function fetchMemoryTool() {
  return tool({
    description:
      'Read the full body of a saved workspace memory by its exact title (titles are listed to you at the start of every turn under <memories>). Use this when a listed memory looks relevant to the current task.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Exact title of the memory to read.'),
    }),
    execute: async ({ title }) => {
      const row = await getMemory(title.trim());
      if (!row) {
        return {
          found: false,
          summary: `No memory titled "${title.trim()}". Check the titles listed under <memories>.`,
        };
      }
      return {
        body: row.body,
        found: true,
        summary: row.summary,
        title: row.title,
      };
    },
  });
}

export function editMemoryTool() {
  return tool({
    description:
      'Update an existing workspace memory (found by its exact title). Pass only the fields you want to change — summary and/or body. To ADD to a memory without losing what is there, fetch it first, then pass the combined body. Memories cannot be deleted.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Exact title of the memory to edit.'),
      summary: z
        .string()
        .max(SUMMARY_MAX)
        .optional()
        .describe('New one-line summary (optional).'),
      body: z
        .string()
        .max(BODY_MAX)
        .optional()
        .describe('New full body — replaces the old body (optional).'),
    }),
    execute: async ({ title, summary, body }) => {
      const trimmedTitle = title.trim();
      if (summary === undefined && body === undefined) {
        return {
          summary: 'Nothing to change — pass a new summary and/or body.',
          updated: false,
        };
      }
      try {
        const row = await updateMemory({
          body,
          summary: summary?.trim(),
          title: trimmedTitle,
        });
        if (!row) {
          return {
            summary: `No memory titled "${trimmedTitle}" to edit. Use saveMemory to create it.`,
            updated: false,
          };
        }
        logger.info({ title: trimmedTitle }, '[memory] edited');
        return { summary: `Updated memory "${trimmedTitle}".`, updated: true };
      } catch (error) {
        return { error: errorMessage(error), updated: false };
      }
    },
  });
}
