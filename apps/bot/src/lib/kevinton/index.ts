import {
  type SandboxContext,
  streamAttempt,
  subagentAttempts,
  subagentSystemPrompt,
} from '@repo/ai';
import {
  claimDueKevintonReviews,
  finishKevintonReview,
  getMcpServer,
  noteKevintonActivity,
} from '@repo/db/queries';
import { LazySandbox } from '@repo/sandbox';
import { type ToolSet, tool } from 'ai';
import { env } from '@/env';
import type { Message } from '@/harness/types';
import { buildPrompt } from '@/lib/agent/prompt';
import { requestHints } from '@/lib/ai/hints';
import { buildMcpTools } from '@/lib/ai/mcp';
import { bot } from '@/lib/chat';
import logger from '@/lib/logger';
import { redactSecretsDeep } from '@/lib/redact';
import { openSandboxProxies } from '@/lib/sandbox/proxies';
import { toLogError } from '@/lib/utils/error';
import { kevintonTools } from './tools';

// kevinton: kyto's after-the-fact reviewer (owner's ask, 2026-09-29, after
// coolton's). Once a thread kyto worked in has been quiet for 30 minutes, it
// runs a full, SILENT kyto turn over what happened and may do two things: file
// (or add to) an issue on kyto's public repo when kyto misbehaved, and propose a
// skill to the owner. It never posts in the thread and never changes code —
// coolton's version opens PRs; kyto's files issues instead (owner's call).
//
// It runs as nobody: a synthetic non-owner author, so no owner-only tool is
// even registered and the GitHub write guard refuses it like any stranger.
// EVERY thread is reviewed — channels, private channels, DMs and group DMs —
// and conversation content may go into the (public) issue: both the owner's
// call, 2026-09-29. Only secret VALUES are redacted on the way out.
//
// It can read kyto's own container logs through the owner's Coolify MCP server
// (the App Home entry named KEVINTON_LOGS_MCP), forced READ-ONLY here whatever
// that entry's own rules say: the token behind it can deploy and restart.

const QUIET_MS = 30 * 60 * 1000;
const POLL_MS = 60 * 1000;
// A claim older than this belongs to a review that died with its instance.
const STALE_CLAIM_MS = 30 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const REVIEWS_PER_POLL = 2;

// What kevinton may use, from the full toolset: everything that LOOKS, nothing
// that speaks. Posting, reacting, scheduling, emailing, deploying and every
// other outward tool are left out, which is what keeps it silent.
const LOOKING_TOOLS = [
  'bash',
  'readFile',
  'writeFile',
  'editFile',
  'viewImage',
  'searchWeb',
  'fetchUrl',
  'readConversationHistory',
  'listThreads',
  'summarizeThread',
  'getUser',
  'getChannelInfo',
  'loadSkill',
  'gh',
] as const;

const KEVINTON_NOTE = `

<kevinton>
You are kevinton, kyto's silent reviewer. You are NOT answering anyone: nobody will see your text, and you cannot post in this thread. The conversation above already happened; kyto (you, in another role) took part in it.

Lines marked \`[## — hidden from kyto's own turns]\` were written starting with \`##\` so kyto would NOT see or answer them — people use that to talk about kyto without interrupting it, and a complaint there ("it keeps replying", "that answer was wrong") is some of the most honest feedback you get. Weigh it like anything else people said back, but never treat it as a request to kyto.

Look at what kyto did — its replies, the thinking it left, errors and failed tool calls, gaps where a reply should be, what people said back — and decide whether either of the first two is warranted, then tend the notebooks (3). For the first two the expected, common outcome is NEITHER; doing nothing is a good review.

1. An ISSUE on kyto's repo, only for a real defect in kyto itself: it stopped mid-turn or went silent, a tool errored or misbehaved, a wrong or broken behaviour people pushed back on, a loop, a refusal it should not have made, a missing capability people clearly needed. Not for a person's mistake, a third-party outage, or a one-off model slip.
2. A SKILL proposal, only for a genuinely reusable, non-obvious method this conversation worked out that would save real work next time — and only if \`loadSkill\`'s list has nothing covering it.

INVESTIGATE BEFORE YOU FILE. An issue that says "kyto stopped mid-turn" is useless; one that says WHY is worth having.
- kyto's logs for THIS thread: \`threadLogs\` — every line kyto logged while working on it (agent, models, tools, sandbox), kept across restarts. Start here. Look for the turn's lifecycle: which model answered or failed and why, fallbacks, watchdog trips, tool errors, stack traces, and where the lines simply STOP (a restart or crash mid-turn).
- Around it, when the coolify tools are there: \`mcp_coolify_list_deployments\` for a deploy at that moment, and \`mcp_coolify_get_logs\` on the kyto APPLICATION (\`mcp_coolify_search_resources\` "kyto") for what the whole process was doing — the current container only, 500 lines.
- kyto's source: \`git clone --depth 1 https://github.com/Devansh-awat/kyto\` in bash (if that fails, \`curl -sL https://codeload.github.com/Devansh-awat/kyto/tar.gz/refs/heads/main | tar xz\`), then grep and read the code the logs point at. Read-only: do not write or run programs.
- \`kytoIssues\` \`search\` first; if it is already reported, \`comment\` with the new evidence instead of filing a duplicate.

A filed issue is DETAILED. Use these sections:
- **What happened** — the symptom as a person saw it, step by step, with approximate times.
- **What kyto was doing** — the model(s), tools and steps involved, from the thread and the logs.
- **Evidence** — the relevant log lines and error messages, quoted exactly, and what people said when it matters.
- **Likely cause** — your diagnosis, with file paths and functions from the source. Say how sure you are.
- **Suggested fix** — concrete.
- **How to reproduce** — if you can tell.

Include whatever from the conversation makes the issue clear — what was asked, what was said back. Never include a secret, a password or a token.

3. NOTEBOOK edits — this one is routine, unlike the other two. kyto keeps notes it reads walking into a conversation: one per channel, and one global that kyto's user account reads in EVERY channel and DM. \`notebook\` \`read\` both first. Add what will help kyto next time: who people are and what they work on, ongoing projects and decisions, preferences and channel norms, recurring questions and their answers, things kyto got wrong and the correction. Not passing chatter, not what is obvious from Slack, never a secret, password or token.
- The channel notebook may hold anything from this channel.
- The global notebook is for what is useful ACROSS channels. Anything you put there can surface anywhere, to anyone. From a private channel, add only what the people in it would not mind being known outside it — personal matters, private plans and anything said in confidence stay in the channel notebook. From a DM or group DM, NEVER (the tool refuses).
- Keep both tight: the limits are hard (channel 20,000 characters, global 50,000), and long before them, merge duplicates, update facts in place with \`replace\`, and drop what is stale. Condense with \`rewrite\` when it grows. A short, current notebook beats a long one.

When you are done, write one line saying what you did (or "nothing to do").
</kevinton>`;

// The Coolify tools kevinton may call, whatever the App Home entry allows:
// reads, and the container logs. Never deploy/control/cancel, never env names.
const LOGS_RULES = {
  read: 'allow',
  sensitive: 'never',
  tools: {
    get_deployment: 'allow',
    get_logs: 'allow',
    list_deployments: 'allow',
  },
  unknown: 'never',
  write: 'never',
} as const;

/** The owner's Coolify MCP, read-only, or nothing if it is not set up. */
async function logTools(): Promise<{
  close: () => Promise<void>;
  tools: ToolSet;
}> {
  const none = { close: () => Promise.resolve(), tools: {} };
  if (!(env.OWNER_USER_ID && env.KEVINTON_LOGS_MCP)) {
    return none;
  }
  const server = await getMcpServer({
    name: env.KEVINTON_LOGS_MCP,
    userId: env.OWNER_USER_ID,
  }).catch(() => undefined);
  if (!server) {
    return none;
  }
  const built = await buildMcpTools({
    logger,
    servers: [
      { namespace: 'coolify', server: { ...server, rules: LOGS_RULES } },
    ],
  });
  // Logs can hold anything a process printed; the backstop runs on them like
  // on every other tool result.
  const tools: ToolSet = {};
  for (const [name, entry] of Object.entries(built.tools)) {
    tools[name] = tool({
      description: entry.description ?? name,
      execute: async (args: unknown, options) =>
        redactSecretsDeep(
          await entry.execute?.(args, options),
          `kevinton ${name}`
        ),
      inputSchema: entry.inputSchema,
    });
  }
  return { close: built.close, tools };
}

/** A turn just ended here; review the thread once it has been quiet 30 min. */
export async function scheduleKevinton(threadId: string): Promise<void> {
  if (!env.KEVINTON_ENABLED) {
    return;
  }
  await noteKevintonActivity({
    dueAt: new Date(Date.now() + QUIET_MS),
    threadId,
  }).catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), threadId },
      '[kevinton] schedule failed'
    );
  });
}

function kevintonMessage({
  reviewedAt,
  threadId,
}: {
  reviewedAt: Date | null;
  threadId: string;
}): Message {
  return {
    attachments: [],
    author: { isBot: true, userId: 'kevinton', userName: 'kevinton' },
    id: `kevinton-${Date.now()}`,
    isMention: false,
    metadata: { dateSent: new Date() },
    raw: {},
    text: `[kevinton review] Review this thread (thread id ${threadId}, as it appears in the logs).${reviewedAt ? ` You last reviewed it at ${reviewedAt.toISOString()}; only what happened after that is new.` : ''}`,
    threadId,
  };
}

async function review({
  reviewedAt,
  threadId,
}: {
  reviewedAt: Date | null;
  threadId: string;
}): Promise<void> {
  const thread = bot.thread(threadId);
  const message = kevintonMessage({ reviewedAt, threadId });
  const proxies = openSandboxProxies({
    isOwner: false,
    threadId,
    userId: message.author.userId,
  });
  // Its own throwaway sandbox: the thread's is somebody's workspace.
  const sandbox = new LazySandbox({
    apiKey: env.E2B_API_KEY,
    bootstrapCommand: proxies.bootstrapCommand,
    env: proxies.env,
    logger,
  });
  const sandboxContext: SandboxContext = {
    session: sandbox,
    sessionWorkDir: sandbox.workDir,
  };
  const { buildTools } = await import('@/lib/ai/toolset');
  let close: (() => Promise<void>) | undefined;
  try {
    const [prompt, hints] = await Promise.all([
      buildPrompt(message, { includeHidden: true, thread }),
      requestHints({ message, thread }),
    ]);
    const built = await buildTools({
      bot,
      getSandboxContext: () => sandboxContext,
      message,
      secret: true,
      thread,
      unattended: true,
    });
    const logs = await logTools().catch((error: unknown) => {
      logger.warn(toLogError(error), '[kevinton] coolify logs unavailable');
      return { close: () => Promise.resolve(), tools: {} };
    });
    close = async () => {
      await Promise.all([built.close(), logs.close()]);
    };
    // Fail closed: a channel whose type can't be read may be a DM.
    const metadata = await thread.fetchMetadata().catch(() => null);
    const own = kevintonTools({
      globalNotebookAllowed: metadata ? !metadata.isDM : false,
      reviewedAt,
      threadId,
    });
    const tools: ToolSet = {
      ...Object.fromEntries(
        LOOKING_TOOLS.flatMap((name) =>
          built.tools[name] ? [[name, built.tools[name]]] : []
        )
      ),
      ...logs.tools,
      kytoIssues: own.kytoIssues,
      notebook: own.notebook,
      proposeSkill: own.proposeSkill,
      threadLogs: own.threadLogs,
    };
    const names = Object.keys(tools);

    for (const attempt of subagentAttempts) {
      try {
        const result = streamAttempt({
          abortSignal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
          activeTools: () => names,
          attempt,
          holder: {},
          prompt,
          system: `${subagentSystemPrompt({ hints })}${KEVINTON_NOTE}`,
          tools,
        });
        let text = '';
        let failed: unknown;
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            text += part.text;
          } else if (part.type === 'error') {
            failed = part.error;
          }
        }
        if (failed && !text) {
          throw failed;
        }
        logger.info(
          {
            filed: own.filed,
            notebook: own.notebookEdits,
            model: attempt.model,
            outcome: text.trim().slice(0, 300),
            proposed: own.proposed,
            threadId,
          },
          '[kevinton] reviewed a thread'
        );
        return;
      } catch (error) {
        // Nothing was said anywhere, so the next rung can simply try again —
        // unless this one already acted, which a second run would repeat.
        if (
          own.filed.length > 0 ||
          own.proposed.length > 0 ||
          own.notebookEdits.length > 0
        ) {
          return;
        }
        logger.warn(
          { ...toLogError(error), model: attempt.model, threadId },
          '[kevinton] attempt failed; trying the next model'
        );
      }
    }
  } finally {
    proxies.revoke();
    await close?.().catch(() => undefined);
    await sandbox.destroy().catch(() => undefined);
  }
}

async function poll(): Promise<void> {
  const now = new Date();
  const due = await claimDueKevintonReviews({
    limit: REVIEWS_PER_POLL,
    now,
    staleClaimBefore: new Date(now.getTime() - STALE_CLAIM_MS),
  }).catch((error: unknown) => {
    logger.warn(toLogError(error), '[kevinton] claim failed');
    return [];
  });
  for (const row of due) {
    // Marked reviewed up to when it STARTED: a turn during the review pushes
    // lastActivityAt past this, so that turn gets its own review later.
    await review(row).catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), threadId: row.threadId },
        '[kevinton] review failed'
      );
    });
    await finishKevintonReview({
      reviewedAt: now,
      threadId: row.threadId,
    }).catch(() => undefined);
  }
}

/** Boot: look for quiet threads once a minute. */
export function startKevinton(): void {
  if (!env.KEVINTON_ENABLED) {
    return;
  }
  let running = false;
  setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    poll().finally(() => {
      running = false;
    });
  }, POLL_MS);
}
