import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs } from 'ai';
import type { Chat, Message, Thread } from 'chat';
import { z } from 'zod';
import { env } from '@/env';
import { getTurn } from '@/lib/agent/turns';
import { getChannelInfoTool } from '@/lib/ai/tools/get-channel-info';
import { getUserTool } from '@/lib/ai/tools/get-user';
import { readConversationHistoryTool } from '@/lib/ai/tools/read-conversation-history';
import { searchWebTool } from '@/lib/ai/tools/search-web';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';
import { rawText, withoutLeadingMentions } from '@/lib/utils/message';

// `/btw` is a concurrent, read-only side channel onto a live (or just-
// finished) kyto turn: "hey, by the way, what are you doing?" without
// touching the main conversation at all. Its own answers are NEVER fed back
// into the main turn's context — it's purely an observer.
//
// UX: typing "?btw <question>" anywhere kyto is listening creates (or
// reuses) a dedicated #kyto-btw channel, starts a fresh thread there linking
// back to the original message, subscribes that thread so follow-ups don't
// need to repeat "?btw", and posts an ephemeral pointer to it in the
// ORIGINAL channel (visible only to the asker). Each answer reads the
// original turn's live activityLog (agent/index.ts's recordActivity) if one
// is still running, or notes that it finished, and runs on a plain
// read-only generateText loop (Gemini 3.1 Flash Lite, never openrouter/auto/
// HackClub) — no sandbox, no write tools, it can only look things up.
//
// In-memory only: the btwThreadId -> originalThreadId mapping does not
// survive a restart (consistent with turns/sandbox state elsewhere — unlike
// reminders, this isn't meant to be durable).
const BTW_CHANNEL_NAME = 'kyto-btw';
const BTW_MODEL = 'gemini-3.1-flash-lite';
const BTW_MAX_STEPS = 6;
// Deliberately NOT a leading "/" — Slack's client blocks any message
// starting with "/" from being sent at all inside a thread reply composer
// (it treats it as a slash-command attempt, even with no command registered
// for it), so "/btw" silently never reached kyto from a thread. "?btw" is
// plain text and works everywhere.
const BTW_TRIGGER = /^\?btw\b\s*(.*)$/is;

const BTW_SYSTEM_PROMPT =
  "You are kyto's read-only status assistant. Someone is asking, on the side, what kyto is currently doing (or did) in another conversation — you are NOT kyto itself and cannot post, react, or take any action, only look things up and answer. You are given kyto's live activity log for that conversation (if it's still working) or told it finished. Answer the question directly and concisely based on that log and whatever you look up. If the log is empty or unavailable, say so plainly rather than guessing.";

const btwThreads = new Map<string, string>();

let btwChannelIdPromise: Promise<string> | undefined;

const conversationsListSchema = z.looseObject({
  channels: z
    .array(z.looseObject({ id: z.string(), name: z.string().optional() }))
    .optional(),
  ok: z.boolean(),
  response_metadata: z
    .looseObject({ next_cursor: z.string().optional() })
    .optional(),
});

const conversationsCreateSchema = z.looseObject({
  channel: z.looseObject({ id: z.string() }).optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});

const permalinkSchema = z.looseObject({
  ok: z.boolean(),
  permalink: z.string().optional(),
});

async function findChannelByName(name: string): Promise<string | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = conversationsListSchema.parse(
      await slack.webClient.apiCall('conversations.list', {
        cursor,
        exclude_archived: true,
        limit: 200,
        types: 'public_channel,private_channel',
      })
    );
    const found = result.channels?.find((channel) => channel.name === name);
    if (found) {
      return found.id;
    }
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) {
      break;
    }
  }
  return;
}

async function resolveBtwChannel(): Promise<string> {
  btwChannelIdPromise ??= (async () => {
    const existing = await findChannelByName(BTW_CHANNEL_NAME);
    if (existing) {
      return existing;
    }
    const created = conversationsCreateSchema.parse(
      await slack.webClient.apiCall('conversations.create', {
        is_private: false,
        name: BTW_CHANNEL_NAME,
      })
    );
    if (!(created.ok && created.channel)) {
      throw new Error(
        `Failed to create #${BTW_CHANNEL_NAME}: ${created.error}`
      );
    }
    return created.channel.id;
  })();
  return await btwChannelIdPromise;
}

function channelIdFromThread(thread: Thread): string | undefined {
  const [platform, channelId] = thread.id.split(':');
  return platform === 'slack' ? channelId : undefined;
}

async function permalinkFor(
  thread: Thread,
  messageTs: string
): Promise<string | undefined> {
  const channelId = channelIdFromThread(thread);
  if (!channelId) {
    return;
  }
  const result = permalinkSchema.parse(
    await slack.webClient.apiCall('chat.getPermalink', {
      channel: channelId,
      message_ts: messageTs,
    })
  );
  return result.ok ? result.permalink : undefined;
}

function activityContext(originalThreadId: string): string {
  const turn = getTurn({ threadId: originalThreadId });
  if (!turn) {
    return 'kyto is not currently working on anything in that thread (no active turn right now).';
  }
  if (turn.activityLog.length === 0) {
    return "kyto's turn just started; no activity recorded yet.";
  }
  return turn.activityLog.join('\n');
}

async function answerBtwQuestion({
  originalThreadId,
  question,
}: {
  originalThreadId: string;
  question: string;
}): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    return '/btw requires GEMINI_API_KEY to be configured.';
  }
  const gemini = createOpenAICompatible({
    apiKey: env.GEMINI_API_KEY,
    baseURL:
      env.GEMINI_BASE_URL ??
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    name: 'gemini',
  });
  try {
    const { text } = await generateText({
      model: gemini.languageModel(BTW_MODEL),
      prompt: `Kyto's current live status in the thread being asked about:\n${activityContext(originalThreadId)}\n\nQuestion: ${question || 'What is kyto currently doing?'}`,
      stopWhen: stepCountIs(BTW_MAX_STEPS),
      system: BTW_SYSTEM_PROMPT,
      tools: {
        getChannelInfo: getChannelInfoTool({
          currentThreadId: originalThreadId,
        }),
        getUser: getUserTool(),
        readConversationHistory: readConversationHistoryTool({
          currentThreadId: originalThreadId,
        }),
        searchWeb: searchWebTool({ apiKey: env.EXA_API_KEY }),
      },
    });
    return text.trim() || '(No update available.)';
  } catch (error) {
    return `Failed to answer: ${errorMessage(error)}`;
  }
}

/** True if this message's thread is a tracked /btw follow-up thread (a
 * plain message here continues the side conversation without needing to
 * repeat "/btw"). */
export function isBtwThread(threadId: string): boolean {
  return btwThreads.has(threadId);
}

/** Handle a plain follow-up message inside a tracked /btw thread. */
export async function continueBtw({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<void> {
  const originalThreadId = btwThreads.get(thread.id);
  if (!originalThreadId) {
    return;
  }
  const answer = await answerBtwQuestion({
    originalThreadId,
    question: withoutLeadingMentions(rawText(message)).trim(),
  });
  await thread.post({ markdown: answer }).catch((error: unknown) => {
    logger.warn(
      { err: errorMessage(error) },
      '[btw] failed to post follow-up answer'
    );
  });
}

/** Detect and handle a "?btw <question>" trigger. Returns true if handled. */
export async function triggerBtw({
  bot,
  message,
  thread,
}: {
  bot: Chat;
  message: Message;
  thread: Thread;
}): Promise<boolean> {
  const body = withoutLeadingMentions(rawText(message)).trim();
  const match = BTW_TRIGGER.exec(body);
  if (!match) {
    return false;
  }
  const question = (match[1] ?? '').trim();
  const originalThreadId = thread.id;

  try {
    const btwChannelId = await resolveBtwChannel();
    const permalink = await permalinkFor(thread, message.id);
    const btwChannel = bot.channel(`slack:${btwChannelId}`);
    const marker = await btwChannel.post({
      markdown: permalink
        ? `🔎 *BTW thread* for ${permalink}`
        : '🔎 *BTW thread* (original message link unavailable)',
    });
    const btwThread = bot.thread(marker.threadId);
    await btwThread.setState({ respondOnThreadMessages: true });
    await btwThread.subscribe();
    btwThreads.set(marker.threadId, originalThreadId);

    await thread
      .postEphemeral(
        message.author,
        `Your BTW thread: <#${btwChannelId}> — ${await permalinkFor(btwThread, marker.id)}`,
        { fallbackToDM: false }
      )
      .catch((error: unknown) => {
        logger.warn(
          { err: errorMessage(error) },
          '[btw] failed to post ephemeral pointer'
        );
      });

    const answer = await answerBtwQuestion({ originalThreadId, question });
    await btwThread.post({ markdown: answer });
  } catch (error) {
    logger.error(
      { err: errorMessage(error) },
      '[btw] failed to handle trigger'
    );
    await thread
      .postEphemeral(message.author, `?btw failed: ${errorMessage(error)}`, {
        fallbackToDM: false,
      })
      .catch(() => undefined);
  }
  return true;
}
