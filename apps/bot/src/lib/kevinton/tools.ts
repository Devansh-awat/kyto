import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { requestApproval } from '@/lib/approvals/request';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { redactSecrets } from '@/lib/redact';
import { getSkill } from '@/lib/skills';
import { parseSkill } from '@/lib/skills/parse';
import { errorMessage } from '@/lib/utils/error';
import { findQuote, scrubForPublic } from './scrub';

// kevinton's only two ways to leave a mark. Everything else it can do is
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

function publicText(text: string): string {
  return redactSecrets(scrubForPublic(text), 'kevinton issue');
}

export function kevintonTools({
  humanMessages,
  threadId,
}: {
  /** What people wrote in the thread, so a quote of it can be refused. */
  humanMessages: string[];
  threadId: string;
}) {
  let issuesThisReview = 0;
  let skillsThisReview = 0;
  const filed: string[] = [];
  const proposed: string[] = [];

  const kytoIssues = tool({
    description: `Kyto's public GitHub issues (${REPO}). \`search\` first, always — a problem that already has an issue gets a \`comment\` with the new evidence, never a duplicate. \`file\` opens a new one. PUBLIC: never quote a message, never name or describe a person, channel or workspace, never include anything from the conversation beyond what kyto did and what went wrong, in your own words. At most ${MAX_ISSUES_PER_REVIEW} new issues or comments per review.`,
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
        const quoted = findQuote({
          messages: humanMessages,
          text: `${title ?? ''}\n${body}`,
        });
        if (quoted) {
          return {
            error: `Not filed: it quotes a person's message ("${quoted}…"). This goes on a PUBLIC tracker — rewrite that part generically in your own words (e.g. "a multi-part question about a hobby project") and try again.`,
            success: false,
          };
        }
        const footer =
          "\n\n---\n_Filed by kevinton, kyto's after-the-fact reviewer, from a conversation it reviewed. Conversation details are deliberately left out._";
        if (action === 'comment') {
          if (!number) {
            return { error: 'comment needs the issue number.', success: false };
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
              title: TITLE_PREFIX + publicText(title),
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

  return { filed, kytoIssues, proposeSkill, proposed };
}
