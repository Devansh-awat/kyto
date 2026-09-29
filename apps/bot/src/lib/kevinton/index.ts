import {
  type SandboxContext,
  streamAttempt,
  subagentAttempts,
  subagentSystemPrompt,
} from '@repo/ai';
import {
  claimDueKevintonReviews,
  finishKevintonReview,
  noteKevintonActivity,
} from '@repo/db/queries';
import { LazySandbox } from '@repo/sandbox';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { Message } from '@/harness';
import { buildPrompt } from '@/lib/agent/prompt';
import { requestHints } from '@/lib/ai/hints';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
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
// even registered and the GitHub write guard refuses it like any stranger. And
// only PUBLIC channels are reviewed — what it writes lands on a public repo,
// and the scrubber cannot catch a paraphrase of a private conversation.

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

Look at what kyto did — its replies, the thinking it left, errors and failed tool calls, what people said back — and decide whether either of these is warranted. The expected, common outcome is NEITHER; doing nothing is a good review.

1. An ISSUE on kyto's repo, only for a real defect in kyto itself: a tool that errored or misbehaved, a wrong or broken behaviour people pushed back on, a loop, a refusal it should not have made, a missing capability people clearly needed. Not for a person's mistake, a third-party outage, or a one-off model slip. \`search\` first and \`comment\` on an existing issue instead of filing a duplicate. You may read kyto's source to point at the right place: \`git clone --depth 1 https://github.com/Devansh-awat/kyto\` in bash. Do not write or run programs beyond reading.
2. A SKILL proposal, only for a genuinely reusable, non-obvious method this conversation worked out that would save real work next time — and only if \`loadSkill\`'s list has nothing covering it.

The issue tracker is PUBLIC. Describe kyto's behaviour in your own words: never quote a message, never name or describe a person, channel or workspace, never include what anyone asked about beyond what is needed to reproduce kyto's fault.

When you are done, write one line saying what you did (or "nothing to do").
</kevinton>`;

const infoSchema = z.looseObject({
  channel: z
    .looseObject({
      is_im: z.boolean().optional(),
      is_mpim: z.boolean().optional(),
      is_private: z.boolean().optional(),
    })
    .optional(),
  ok: z.boolean(),
});

const publicChannels = new Map<string, boolean>();

async function isPublicChannel(channel: string): Promise<boolean> {
  const known = publicChannels.get(channel);
  if (known !== undefined) {
    return known;
  }
  const info = infoSchema.safeParse(
    await slack.webClient
      .apiCall('conversations.info', { channel })
      .catch(() => null)
  );
  const isPublic =
    info.success &&
    info.data.ok &&
    !(
      info.data.channel?.is_private ||
      info.data.channel?.is_im ||
      info.data.channel?.is_mpim
    );
  publicChannels.set(channel, isPublic);
  return isPublic;
}

/** A turn just ended here; review the thread once it has been quiet 30 min. */
export async function scheduleKevinton(threadId: string): Promise<void> {
  if (!env.KEVINTON_ENABLED) {
    return;
  }
  const { channel } = slack.decodeThreadId(threadId);
  if (!(await isPublicChannel(channel))) {
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
    text: reviewedAt
      ? `[kevinton review] Review this thread. You last reviewed it at ${reviewedAt.toISOString()}; only what happened after that is new.`
      : '[kevinton review] Review this thread.',
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
      buildPrompt(message, { thread }),
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
    close = built.close;
    const own = kevintonTools({ threadId });
    const tools: ToolSet = {
      ...Object.fromEntries(
        LOOKING_TOOLS.flatMap((name) =>
          built.tools[name] ? [[name, built.tools[name]]] : []
        )
      ),
      kytoIssues: own.kytoIssues,
      proposeSkill: own.proposeSkill,
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
        if (own.filed.length > 0 || own.proposed.length > 0) {
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
