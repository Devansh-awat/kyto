import { z } from 'zod';
import { env } from '@/env';
import logger from '@/lib/logger';
import { recordJevSpend } from '@/lib/spend';
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
// The newest end of the thread. Jev refuses ~200k chars (max_tokens_exceeded)
// and took 100k in 0.6s (measured 2026-10-17).
const MAX_STATE_CHARS = 100_000;

// Each group is ONE yes/no question and the deferred tools it unlocks. A
// question names the ACTION the latest message must call for. Worded as "is
// this about X" or "would a helper help", they said yes to a topic merely
// present in the thread: in the week before 2026-11-22 subagents were preloaded
// 18 times and used 0, context7 11 and 0, slackBrowser picked on 85 of 427 turns.
const GROUPS = {
  background: {
    question:
      'Does it ask to start something that keeps running (a server, a long download or build) and check on it later?',
    tools: ['runBackgroundProcess', 'getProcessOutput', 'killProcess'],
  },
  browser: {
    question:
      'Does doing it mean operating a website outside Slack: clicking, filling in a form, logging in, or taking a screenshot? Reading, summarizing or checking a page, or a page that merely has a link in the message, is NO.',
    tools: ['browser'],
  },
  canvases: {
    question:
      'Does it ask to read, create, edit or list a Slack canvas? A link to a canvas the message wants opened counts.',
    tools: ['canvasRead', 'canvasWrite', 'canvasList'],
  },
  channelAdmin: {
    question:
      'Does it ask the assistant to create or join a channel, invite someone to one, set a channel topic, add a bookmark, or pin or unpin a message?',
    tools: [
      'createChannel',
      'joinChannel',
      'inviteToChannel',
      'setChannelTopic',
      'bookmarkLink',
      'pinMessage',
      'unpinMessage',
    ],
  },
  codeChannels: {
    question:
      'Does it ask to create, turn on, turn off, list, rename or archive a code channel, or to change its tabs, context bar or commands?',
    tools: [
      'createCodeChannel',
      'enableCodeChannel',
      'disableCodeChannel',
      'listCodeChannels',
      'setCodeChannelHtmlTab',
      'setCodeChannelDiffTab',
      'setCodeChannelCanvasTab',
      'setCodeChannelBlockKitTab',
      'setCodeChannelPullRequestTab',
      'setCodeChannelContextBar',
      'setCodeChannelCommands',
      'listCodeChannelViews',
      'removeCodeChannelView',
      'readCodeChannelCanvas',
      'renameCodeChannel',
      'archiveCodeChannel',
    ],
  },
  diagrams: {
    question:
      'Does it ask for a diagram, flowchart or chart to be drawn as a picture? An emoji, a meme or an ordinary explanation is NO.',
    tools: ['mermaid'],
  },
  email: {
    question:
      "Does it ask the assistant to send an email, or to look in the assistant's own inbox for one? Email merely being mentioned is NO.",
    tools: ['sendEmail', 'checkInbox', 'readEmail', 'replyEmail'],
  },
  embeds: {
    question:
      'Does it ask for a live interactive page or a shared whiteboard posted inside Slack?',
    tools: ['embed', 'removeEmbed'],
  },
  emojiEdit: {
    question:
      'Does it ask to add a custom emoji to the workspace, or to remove one?',
    tools: ['submitEmoji', 'removeEmoji'],
  },
  emojiLookup: {
    question:
      'Does answering it mean knowing what a particular custom emoji looks like? An emoji just used in the message is NO.',
    tools: ['lookupEmoji'],
  },
  github: {
    question:
      'Does it ask to look at or change something on GitHub: a repository, issue, pull request or user? Code or a link mentioned without that ask is NO.',
    tools: ['gh'],
  },
  githubClaims: {
    question:
      'Does it ask who may change a GitHub repository through the assistant, or to change or drop that?',
    tools: [
      'listGithubRepoClaims',
      'releaseGithubRepo',
      'setGithubRepoEditors',
    ],
  },
  images: {
    question: 'Does it ask for an AI image or picture to be generated?',
    tools: ['generateImage'],
  },
  imageHunt: {
    question:
      'Does it ask to find a specific image, meme, screenshot or picture someone posted in Slack?',
    tools: ['findImages'],
  },
  libraryDocs: {
    question:
      'Does it ask how to use a named programming library, framework, SDK or API, in a way its official documentation would answer? Running a command, installing a package, or code in general is NO.',
    tools: ['mcp_context7_resolve-library-id', 'mcp_context7_query-docs'],
  },
  memoryFiles: {
    question:
      'Does it ask the assistant to delete or bring back a saved memory, or to keep, restore or remove a folder of files with one?',
    tools: [
      'attachMemoryFiles',
      'deleteMemory',
      'detachMemoryFiles',
      'restoreMemory',
      'restoreMemoryFiles',
    ],
  },
  polls: {
    question:
      'Does it ask for a poll or an NPS survey, for survey results, or to ask specific people a multiple-choice question and wait for the answer?',
    tools: ['poll', 'askQuestion', 'npsSurvey', 'npsResults', 'closeNpsSurvey'],
  },
  reminders: {
    question:
      'Does it ask the assistant to set a reminder or a scheduled, repeating or triggered task, or to list, change, pause, resume or cancel one?',
    tools: [
      'scheduleReminder',
      'scheduleRecurringReminder',
      'scheduleEventReminder',
      'listReminders',
      'editReminder',
      'cancelReminder',
      'pauseReminder',
      'resumeReminder',
    ],
  },
  sites: {
    question:
      'Does it ask for a website to be published at a public URL, or a published one listed or taken down?',
    tools: ['deploySite', 'listSites', 'removeSite'],
  },
  // Owner-only, so it preloads nothing for anyone else (`preload` keeps only
  // registered tools). Without it, "use the slack browser" preloaded the plain
  // `browser`, which isn't logged in, and the model landed on Slack's sign-in.
  slackBrowser: {
    question:
      "Does it name the Slack browser, or ask to click or fill in something in Slack's own app: another app's button or form, a workflow, an App Home or a Slack settings page? Reading, searching or checking messages, channels or people is NO.",
    tools: ['slackBrowser'],
  },
  slackReference: {
    question:
      "Does it ask to build or fix something in Slack's own formats: a Block Kit message, canvas markdown, or a search using modifiers? Ordinary writing or searching is NO.",
    tools: ['slackDocs'],
  },
  slackScript: {
    question:
      'Does it ask for a count, ranking or scan over a lot of Slack data at once: many channels, users or messages?',
    tools: ['slackScript'],
  },
  speech: {
    question: 'Does it ask for spoken audio (text to speech)?',
    tools: ['textToSpeech'],
  },
  subagent: {
    question:
      'Does it ask for helper agents, or plainly ask for several separate large jobs at once (reports on different subjects, audits of different repositories)? One question, even a hard one that takes many lookups, is NO.',
    tools: ['runSubagent', 'checkSubagent'],
  },
} as const satisfies Record<string, { question: string; tools: string[] }>;

// Said once per question: the state is the whole thread, and Jev read topics
// from anywhere in it.
const PRELOAD_INSTRUCTIONS =
  'An AI assistant in Slack is about to handle the LATEST message in this conversation. Judge that message only: the earlier ones are there to say what "it" or "that" refers to, and something the thread was about before does not count. Say yes only when the answer is plain; if unsure, say no, since the assistant can still get the tool itself.';

type GroupId = keyof typeof GROUPS;

// The turn's reasoning effort, in the same call (owner's ask 2026-10-17: the
// random draw ran a malware scan at `low`). The primary takes Jev's pick every
// turn.
// No `low` (owner's call 2026-11-21): 19 of 20 skipped turns in the week before
// ran at low, and a quick reply at medium costs little more.
const JEV_EFFORTS = ['medium', 'high'] as const;
type JevEffort = (typeof JEV_EFFORTS)[number];
const EFFORT_CRITERIA: Record<JevEffort, string> = {
  high: 'Deep multi-step work where careful thinking pays off: investigating or analysing something (a file, a codebase, a security scan), debugging, research across many sources, a hard problem, or an answer that must be thorough and correct.',
  medium:
    'Chat, a quick reply or factual answer, or an ordinary task: a few lookups or tool calls, a short explanation, a modest edit or summary.',
};
const EFFORT_INSTRUCTIONS =
  'An AI assistant in Slack is about to handle the latest message in this conversation. How much reasoning effort does doing it WELL need?';

const isEffort = (value: string): value is JevEffort =>
  JEV_EFFORTS.some((effort) => effort === value);

const answerSchema = z.object({ noul: z.number().min(0).max(1) });
const choiceSchema = z.object({
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
});
const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
});

export interface EffortPicks {
  /** What the turn runs at. */
  effort: JevEffort;
  /** Jev's own numbers, logged so its calls can be judged later. */
  probabilities: Record<string, number>;
}

/**
 * The deferred tool names Jev thinks this turn will need and (given `effort`)
 * the turn's reasoning effort;
 * nothing of any if it could not say. `conversation` is the thread as kyto
 * sees it, the new message last.
 */
export async function pickPreloadTools({
  conversation,
  effort: askEffort,
}: {
  conversation: string;
  /** Ask for the effort too. */
  effort?: boolean;
}): Promise<{
  effort?: EffortPicks;
  tools: string[];
}> {
  const none = { tools: [] };
  const state = conversation.trim().slice(-MAX_STATE_CHARS);
  if (!state) {
    return none;
  }
  const questions: Record<string, unknown> = Object.fromEntries(
    Object.entries(GROUPS).map(([id, group]) => [
      id,
      {
        instructions: `${PRELOAD_INSTRUCTIONS} ${group.question}`,
        type: 'noul',
      },
    ])
  );
  if (askEffort) {
    questions.effort = {
      criteria: EFFORT_CRITERIA,
      instructions: EFFORT_INSTRUCTIONS,
      type: 'choice',
    };
  }
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
      return none;
    }
    const body: unknown = await response.json();
    recordJevSpend({ body, source: 'jev-preload' });
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      return none;
    }
    const { answers } = parsed.data;
    const noul = (id: string) =>
      answerSchema.safeParse(answers[id]).data?.noul ?? 0;
    const picked = (Object.keys(GROUPS) as GroupId[]).filter(
      (id) => noul(id) >= PRELOAD_THRESHOLD
    );
    let effort: EffortPicks | undefined;
    const pick = choiceSchema.safeParse(answers.effort).data;
    if (askEffort && pick && isEffort(pick.choice)) {
      effort = { effort: pick.choice, probabilities: pick.probabilities };
    }
    logger.info({ effort, picked }, '[tool-preload] jev picked tool groups');
    return {
      ...(effort ? { effort } : {}),
      tools: picked.flatMap((id) => [...GROUPS[id].tools]),
    };
  } catch (error) {
    logger.warn(
      toLogError(error),
      '[tool-preload] jev call failed; preloading nothing'
    );
    return none;
  }
}
