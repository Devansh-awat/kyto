import { getNotebooks, saveNotebook } from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { requestApproval } from '@/lib/approvals/request';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  applyNotebookEdit,
  GLOBAL_NOTEBOOK,
  MAX_CHANNEL_NOTEBOOK_CHARS,
  MAX_GLOBAL_NOTEBOOK_CHARS,
} from '@/lib/notebooks';
import { redactSecrets } from '@/lib/redact';
import { getSkill } from '@/lib/skills';
import { parseSkill } from '@/lib/skills/parse';
import { threadLogText } from '@/lib/thread-logs';
import { errorMessage } from '@/lib/utils/error';

// kevinton's ways to leave a mark: an issue, a skill proposal, and kyto's
// notebooks (lib/notebooks.ts). Everything else it can do is
// looking: it never posts in the thread it reviews, and never changes code.

// Owner's call, 2026-09-29: issues go straight onto kyto's own public repo.
const REPO = 'Devansh-awat/kyto';
const TITLE_PREFIX = '[kevinton] ';
// kyto-agent can open issues on the repo but not label them (no triage
// access), so the prefix is what marks them — and what the daily count finds.
const MAX_ISSUES_PER_REVIEW = 2;
const MAX_ISSUES_PER_DAY = 8;
const MAX_SKILLS_PER_REVIEW = 1;

const issueSchema = z.looseObject({
  html_url: z.string(),
  number: z.number(),
  state: z.string(),
  title: z.string(),
});
const searchSchema = z.looseObject({
  items: z.array(issueSchema),
  total_count: z.number(),
});

async function github(
  path: string,
  init: { body?: unknown; method?: string } = {}
): Promise<unknown> {
  if (!env.GH_TOKEN) {
    throw new Error('GH_TOKEN is not set, so kevinton cannot reach GitHub.');
  }
  const response = await fetch(`https://api.github.com${path}`, {
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    method: init.method ?? 'GET',
    signal: AbortSignal.timeout(20_000),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `GitHub ${response.status}: ${JSON.stringify(json).slice(0, 300)}`
    );
  }
  return json;
}

// Conversation content may go into an issue (owner's call); secret values may not.
function publicText(text: string): string {
  return redactSecrets(text, 'kevinton issue');
}

// Plenty for a long turn's worth of kyto's verbose logs; past it the OLDEST
// lines go, since the end of a turn is where it broke.
const MAX_LOG_CHARS = 150_000;

export function kevintonTools({
  globalNotebookAllowed,
  reviewedAt,
  threadId,
}: {
  /** False for a DM or group DM, or when the channel's type is unknown. */
  globalNotebookAllowed: boolean;
  reviewedAt: Date | null;
  threadId: string;
}) {
  let issuesThisReview = 0;
  let skillsThisReview = 0;
  const filed: string[] = [];
  const proposed: string[] = [];

  const kytoIssues = tool({
    description: `Kyto's public GitHub issues (${REPO}). \`search\` first, always — a problem that already has an OPEN issue gets a \`comment\` with the new evidence, never a duplicate. A CLOSED one can't be reopened (kyto-agent has no write access) and a comment there goes unseen, so a recurrence gets a new \`file\` whose body starts "Recurrence of #N" with what is new since the fix. \`file\` opens a new one. Never include a secret, password or token. At most ${MAX_ISSUES_PER_REVIEW} new issues or comments per review.`,
    inputSchema: z.object({
      action: z.enum(['search', 'file', 'comment']),
      body: z
        .string()
        .max(8000)
        .optional()
        .describe(
          'file/comment: what kyto did, what went wrong, the evidence (errors, tool names, code paths), and a suggested fix.'
        ),
      number: z
        .number()
        .int()
        .optional()
        .describe('comment: the issue number.'),
      query: z.string().max(200).optional().describe('search: keywords.'),
      title: z.string().max(120).optional().describe('file: a short title.'),
    }),
    execute: async ({ action, body, number, query, title }) => {
      try {
        if (action === 'search') {
          const q = encodeURIComponent(
            `repo:${REPO} is:issue ${(query ?? '').replace(/[^\w\s.-]/g, ' ')}`
          );
          const result = searchSchema.parse(
            await github(`/search/issues?q=${q}&per_page=10`)
          );
          return {
            issues: result.items.map((item) => ({
              number: item.number,
              state: item.state,
              title: item.title,
            })),
            success: true,
            total: result.total_count,
          };
        }
        if (issuesThisReview >= MAX_ISSUES_PER_REVIEW) {
          return {
            error: `Already ${MAX_ISSUES_PER_REVIEW} this review — that is the limit. Stop here.`,
            success: false,
          };
        }
        if (!body) {
          return { error: `${action} needs a body.`, success: false };
        }
        const footer =
          "\n\n---\n_Filed by kevinton, kyto's after-the-fact reviewer, from a conversation it reviewed. Conversation details are deliberately left out._";
        if (action === 'comment') {
          if (!number) {
            return { error: 'comment needs the issue number.', success: false };
          }
          // kyto-agent only has read access, so it can't reopen an issue the
          // owner closed, and a comment on a closed issue is never seen.
          const target = issueSchema.parse(
            await github(`/repos/${REPO}/issues/${number}`)
          );
          if (target.state === 'closed') {
            return {
              error: `#${number} is closed and can't be reopened. File a NEW issue instead: body starts "Recurrence of #${number} (closed as fixed)", then what still fails and why the fix didn't cover it.`,
              success: false,
            };
          }
          await github(`/repos/${REPO}/issues/${number}/comments`, {
            body: { body: publicText(body) + footer },
            method: 'POST',
          });
          issuesThisReview += 1;
          filed.push(`comment on #${number}`);
          return { success: true, summary: `Commented on #${number}.` };
        }
        if (!title) {
          return { error: 'file needs a title.', success: false };
        }
        const today = new Date().toISOString().slice(0, 10);
        const todays = searchSchema.parse(
          await github(
            `/search/issues?q=${encodeURIComponent(`repo:${REPO} is:issue author:${env.GH_LOGIN} in:title "[kevinton]" created:>=${today}`)}&per_page=1`
          )
        );
        if (todays.total_count >= MAX_ISSUES_PER_DAY) {
          return {
            error: `${MAX_ISSUES_PER_DAY} kevinton issues already today — the daily limit. Stop here.`,
            success: false,
          };
        }
        const created = issueSchema.parse(
          await github(`/repos/${REPO}/issues`, {
            body: {
              body: publicText(body) + footer,
              // The prompt shows titles with the prefix, so the model often
              // writes it itself; without this they read "[kevinton] [kevinton]".
              title:
                TITLE_PREFIX +
                publicText(title).replace(/^(\s*\[kevinton\]\s*)+/i, ''),
            },
            method: 'POST',
          })
        );
        issuesThisReview += 1;
        filed.push(`#${created.number}`);
        logger.info(
          { issue: created.number, threadId },
          '[kevinton] filed an issue'
        );
        return {
          number: created.number,
          success: true,
          summary: `Filed #${created.number}.`,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  const proposeSkill = tool({
    description: `Propose a new skill, or an edit to one, for the owner to approve. Nothing goes live until they do. Give the COMPLETE SKILL.md: frontmatter (name: lowercase-hyphenated, description: when to use it), then clear, general instructions. Only for a genuinely reusable method that would save real work next time — the default is to propose nothing. At most ${MAX_SKILLS_PER_REVIEW} per review. Never put anything from the conversation into it.`,
    inputSchema: z.object({
      markdown: z.string().max(20_000),
      why: z
        .string()
        .max(500)
        .describe(
          'One or two sentences for the owner: why this is worth having.'
        ),
    }),
    execute: async ({ markdown, why }) => {
      if (skillsThisReview >= MAX_SKILLS_PER_REVIEW) {
        return { error: 'One proposal per review. Stop here.', success: false };
      }
      const parsed = parseSkill(markdown);
      if (!parsed.ok) {
        return { error: parsed.error, success: false };
      }
      if (!env.OWNER_USER_ID) {
        return {
          error: 'No owner is configured to approve it.',
          success: false,
        };
      }
      try {
        const existing = await getSkill(parsed.skill.name);
        // The owner's DM, never the reviewed thread: kevinton is silent there.
        const dm = await bot.openDM(env.OWNER_USER_ID);
        await requestApproval({
          detail: `${redactSecrets(why, 'kevinton skill')}\n\n${redactSecrets(markdown, 'kevinton skill')}`,
          kind: 'skill',
          payload: { markdown },
          requestedBy: slack.botUserId ?? 'kevinton',
          summary: `${existing ? 'change' : 'add'} the "${parsed.skill.name}" skill (kevinton's proposal)`,
          threadId: dm.id,
        });
        skillsThisReview += 1;
        proposed.push(parsed.skill.name);
        return {
          success: true,
          summary: `Proposed "${parsed.skill.name}" to the owner. It is NOT live until approved.`,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  const threadLogs = tool({
    description:
      "Every log line kyto emitted while working on THIS thread — agent lifecycle, model attempts and failures, tool calls and errors, sandbox — kept across restarts for a week. Start any investigation here. `all: true` includes lines from before your last review. `timing: true` returns ONLY the lines that say where each turn's time went (per turn and per attempt, plus E2B), even ones the full log would cut — ask for it when a turn was slow.",
    inputSchema: z.object({
      all: z.boolean().optional(),
      timing: z.boolean().optional(),
    }),
    execute: async ({ all, timing: timingOnly }) => {
      const { text, timing, truncated } = await threadLogText({
        maxChars: MAX_LOG_CHARS,
        threadId,
        ...(reviewedAt && !all ? { since: reviewedAt } : {}),
      });
      // Only on request: most reviews have no slow turn, and every line here
      // is paid for again on each later step of the review.
      if (timingOnly) {
        return {
          timing: timing.length
            ? timing.join('\n')
            : 'No timing lines captured for this thread.',
        };
      }
      return {
        logs:
          text ||
          'No lines captured for this thread (it predates the capture, or they were pruned after a week).',
        ...(truncated ? { note: 'The oldest lines were cut to fit.' } : {}),
      };
    },
  });

  const channelId = slack.decodeThreadId(threadId).channel;
  const notebookEdits: string[] = [];
  const notebook = tool({
    description: `kyto's notebooks. \`channel\` is THIS channel's (max ${MAX_CHANNEL_NOTEBOOK_CHARS} chars) — both kytos read it here. \`global\` is workspace-wide (max ${MAX_GLOBAL_NOTEBOOK_CHARS} chars) — kyto's user account reads it in EVERY channel and DM.${globalNotebookAllowed ? '' : ' This thread is a DM, so the global notebook is read-only here.'} \`read\` returns both. \`append\` adds lines; \`replace\` swaps one exact, unique \`find\` for \`text\` (empty text deletes it); \`rewrite\` replaces the whole notebook — use it to condense.`,
    inputSchema: z.object({
      action: z.enum(['read', 'append', 'replace', 'rewrite']),
      find: z.string().optional(),
      notebook: z.enum(['channel', 'global']).optional(),
      text: z.string().optional(),
    }),
    execute: async ({ action, find, notebook: which, text }) => {
      try {
        const found = await getNotebooks([GLOBAL_NOTEBOOK, channelId]);
        if (action === 'read') {
          return {
            channel: found.get(channelId) ?? '',
            global: found.get(GLOBAL_NOTEBOOK) ?? '',
          };
        }
        if (!which) {
          return { error: `${action} needs \`notebook\`.`, success: false };
        }
        if (which === 'global' && !globalNotebookAllowed) {
          return {
            error:
              'Nothing from a DM may go into the global notebook — it would be read in every channel.',
            success: false,
          };
        }
        if (
          text === undefined ||
          (action === 'replace' && find === undefined)
        ) {
          return { error: `${action} needs its fields.`, success: false };
        }
        const scope = which === 'global' ? GLOBAL_NOTEBOOK : channelId;
        const max =
          which === 'global'
            ? MAX_GLOBAL_NOTEBOOK_CHARS
            : MAX_CHANNEL_NOTEBOOK_CHARS;
        const clean = redactSecrets(text, 'kevinton notebook');
        const edited = applyNotebookEdit({
          content: found.get(scope) ?? '',
          edit:
            action === 'replace'
              ? { action, find: find ?? '', text: clean }
              : { action, text: clean },
          max,
        });
        if ('error' in edited) {
          return { error: edited.error, success: false };
        }
        await saveNotebook({ content: edited.content, scope });
        notebookEdits.push(`${which} ${action}`);
        logger.info(
          { action, chars: edited.content.length, scope, threadId },
          '[kevinton] edited a notebook'
        );
        return {
          success: true,
          summary: `The ${which} notebook is now ${edited.content.length} of ${max} characters.`,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  return {
    filed,
    kytoIssues,
    notebook,
    notebookEdits,
    proposeSkill,
    proposed,
    threadLogs,
  };
}
