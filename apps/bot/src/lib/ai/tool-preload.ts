import { z } from 'zod';
import { env } from '@/env';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// Jev decides, once at the start of a turn, which DEFERRED tools it will need,
// and they are loaded before the first step (owner's ask, 2026-09-29, after
// coolton's version of this). Without it, a turn that needs the browser spends a
// whole model round trip calling `loadTools` first — billed at full price.
//
// It never takes anything away: a group Jev misses is still one `loadTools`
// call away, and a failure or a slow answer just means nothing is preloaded.
// Runs in parallel with the anti-coding check, so it adds no wait of its own.

const JEV_URL = 'https://ai.hackclub.com/proxy/v1/jev/systemone';
const JEV_TIMEOUT_MS = 3000;
// Coolton's threshold: a coin-flip "maybe" is worth a schema in the prompt,
// since the alternative is a round trip.
const PRELOAD_THRESHOLD = 0.5;
const MAX_STATE_CHARS = 6000;

// Each group is ONE yes/no question and the deferred tools it unlocks. Keep the
// questions about what the TURN needs, not what the tools are called.
const GROUPS = {
  background: {
    question:
      'Will the assistant need to start a long-running command in the background and check on it later?',
    tools: ['runBackgroundProcess', 'getProcessOutput', 'killProcess'],
  },
  browser: {
    question:
      'Will the assistant need to open and interact with a website in a real browser — clicking, filling forms, logging in, screenshots, or a page that needs JavaScript?',
    tools: ['browser'],
  },
  channelAdmin: {
    question:
      'Will the assistant need to create a Slack channel, set a channel topic, add a bookmark, or pin or unpin a message?',
    tools: [
      'createChannel',
      'setChannelTopic',
      'bookmarkLink',
      'pinMessage',
      'unpinMessage',
    ],
  },
  codeChannels: {
    question:
      'Does this ask to create, turn on, turn off or list a code channel?',
    tools: ['codeChannel'],
  },
  diagrams: {
    question:
      'Will the assistant need to draw a diagram, flowchart or chart as an image?',
    tools: ['mermaid'],
  },
  email: {
    question:
      "Does this involve email — sending one, or checking or reading the assistant's inbox?",
    tools: ['sendEmail', 'checkInbox', 'readEmail', 'replyEmail'],
  },
  embeds: {
    question:
      'Will the assistant need to post a live interactive web page or a shared whiteboard inside Slack?',
    tools: ['embed', 'removeEmbed'],
  },
  emoji: {
    question:
      'Is this about a custom Slack emoji — what one depicts, or adding or removing one?',
    tools: ['lookupEmoji', 'submitEmoji', 'removeEmoji'],
  },
  github: {
    question:
      'Will the assistant need to use GitHub — look at repositories, issues or pull requests, or change who may write to a repo?',
    tools: ['gh', 'githubAccess'],
  },
  libraryDocs: {
    question:
      'Is this about how to use a specific programming library, framework, SDK or API, where current documentation would help?',
    tools: ['mcp_context7_resolve-library-id', 'mcp_context7_query-docs'],
  },
  polls: {
    question:
      'Will the assistant need to run a poll, or ask specific people a multiple-choice question and wait for their answer?',
    tools: ['poll', 'askQuestion'],
  },
  slackReference: {
    question:
      "Will the assistant need Slack's own formatting reference — Block Kit blocks, canvas markdown or search modifiers?",
    tools: ['slackDocs'],
  },
  slackScript: {
    question:
      'Does this need a large aggregate query over Slack data — counting, ranking or scanning many channels, users or messages at once?',
    tools: ['slackScript'],
  },
  speech: {
    question: 'Does this ask for spoken audio (text to speech)?',
    tools: ['textToSpeech'],
  },
  subagent: {
    question:
      'Is this a big multi-part task worth handing a piece of to a separate helper agent that reports back?',
    tools: ['runSubagent', 'checkSubagent'],
  },
} as const satisfies Record<string, { question: string; tools: string[] }>;

type GroupId = keyof typeof GROUPS;

const answerSchema = z.object({ noul: z.number().min(0).max(1) });
const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
});

/**
 * The deferred tool names Jev thinks this turn will need, or [] if it could not
 * say. `conversation` is the prompt the model is about to get.
 */
export async function pickPreloadTools(
  conversation: string
): Promise<string[]> {
  const state = conversation.trim().slice(-MAX_STATE_CHARS);
  if (!state) {
    return [];
  }
  const questions = Object.fromEntries(
    Object.entries(GROUPS).map(([id, group]) => [
      id,
      {
        instructions: `An AI assistant in Slack is about to handle the latest message in this conversation. ${group.question}`,
        type: 'noul',
      },
    ])
  );
  try {
    const response = await fetch(JEV_URL, {
      body: JSON.stringify({ questions, state }),
      headers: {
        Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        '[tool-preload] jev refused; preloading nothing'
      );
      return [];
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return [];
    }
    const picked = (Object.keys(GROUPS) as GroupId[]).filter(
      (id) => (parsed.data.answers[id]?.noul ?? 0) >= PRELOAD_THRESHOLD
    );
    logger.info({ picked }, '[tool-preload] jev picked tool groups');
    return picked.flatMap((id) => [...GROUPS[id].tools]);
  } catch (error) {
    logger.warn(
      toLogError(error),
      '[tool-preload] jev call failed; preloading nothing'
    );
    return [];
  }
}
