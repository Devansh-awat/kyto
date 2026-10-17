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
      'Will the assistant need to open and interact with a website OUTSIDE Slack in a real browser — clicking, filling forms, logging in, screenshots, or a page that needs JavaScript?',
    tools: ['browser'],
  },
  canvases: {
    question:
      'Will the assistant need to read, create, edit or list a Slack canvas?',
    tools: ['canvasRead', 'canvasWrite', 'canvasList'],
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
      'Does this ask to create, turn on, turn off, list, rename or archive a code channel, or to change its tabs, context bar or commands?',
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
  images: {
    question: 'Does this ask to generate or create an AI image or picture?',
    tools: ['generateImage'],
  },
  imageHunt: {
    question:
      'Does it ask to find a specific image, meme, screenshot or picture someone posted in Slack?',
    tools: ['findImages'],
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
  reminders: {
    question:
      'Is this about a reminder or a scheduled or repeating task \u2014 setting one, or listing, changing, pausing, resuming or cancelling one?',
    tools: [
      'scheduleReminder',
      'scheduleRecurringReminder',
      'listReminders',
      'editReminder',
      'cancelReminder',
      'pauseReminder',
      'resumeReminder',
    ],
  },
  sites: {
    question:
      'Will the assistant need to publish a website at a public URL, or list or take down one it published?',
    tools: ['deploySite', 'listSites', 'removeSite'],
  },
  // Owner-only, so it preloads nothing for anyone else (`preload` keeps only
  // registered tools). Without it, "use the slack browser" preloaded the plain
  // `browser`, which isn't logged in, and the model landed on Slack's sign-in.
  slackBrowser: {
    question:
      "Will the assistant need to click or fill something inside Slack's own app as a person would — another app's button or form on a Slack message, a workflow, an App Home or a Slack settings page — or was it asked to use the Slack browser?",
    tools: ['slackBrowser'],
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

// The turn's reasoning effort, in the same call (owner's ask 2026-10-17: the
// random draw ran a malware scan at `low`). Haiku takes Jev's pick every turn.
// Luna keeps one prompt cache PER EFFORT, so it is only ever raised from where
// the thread is, and only when Jev is sure (owner's call).
export const JEV_EFFORTS = ['low', 'medium', 'high'] as const;
export type JevEffort = (typeof JEV_EFFORTS)[number];
const EFFORT_CRITERIA: Record<JevEffort, string> = {
  high: 'Deep multi-step work where careful thinking pays off: investigating or analysing something (a file, a codebase, a security scan), debugging, research across many sources, a hard problem, or an answer that must be thorough and correct.',
  low: 'Chat, a quick reply or factual answer, one simple action, or a follow-up whose work is already done.',
  medium:
    'An ordinary task: a few lookups or tool calls, a short explanation, a modest edit or summary.',
};
const EFFORT_INSTRUCTIONS =
  'An AI assistant in Slack is about to handle the latest message in this conversation. How much reasoning effort does doing it WELL need?';
const KEEP = 'keep';
// "Sure": a summary ask scored 0.58 for low → medium, a malware scan 0.78 for
// medium → high and a debugging ask 0.92 (measured 2026-10-17).
const LUNA_RAISE_THRESHOLD = 0.7;

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
  /** What haiku runs at. */
  haiku: JevEffort;
  /** What luna runs at: `current`, or higher when Jev was sure. */
  luna: JevEffort;
  lunaRaised: boolean;
  /** Jev's own numbers, logged so its calls can be judged later. */
  probabilities: {
    haiku: Record<string, number>;
    luna?: Record<string, number>;
  };
}

/**
 * The deferred tool names Jev thinks this turn will need and (given
 * `lunaEffort`) the turn's reasoning effort;
 * nothing of any if it could not say. `conversation` is the thread as kyto
 * sees it, the new message last.
 */
export async function pickPreloadTools({
  conversation,
  lunaEffort,
}: {
  conversation: string;
  /** The effort this thread's luna attempts run at now; omit to skip effort. */
  lunaEffort?: JevEffort;
}): Promise<{
  effort?: EffortPicks;
  tools: string[];
}> {
  const none = { tools: [] };
  const state = conversation.trim().slice(-MAX_STATE_CHARS);
  if (!state) {
    return none;
  }
  const higher = lunaEffort
    ? JEV_EFFORTS.slice(JEV_EFFORTS.indexOf(lunaEffort) + 1)
    : [];
  const questions: Record<string, unknown> = Object.fromEntries(
    Object.entries(GROUPS).map(([id, group]) => [
      id,
      {
        instructions: `An AI assistant in Slack is about to handle the latest message in this conversation. ${group.question}`,
        type: 'noul',
      },
    ])
  );
  if (lunaEffort) {
    questions.effort = {
      criteria: EFFORT_CRITERIA,
      instructions: EFFORT_INSTRUCTIONS,
      type: 'choice',
    };
  }
  if (lunaEffort && higher.length > 0) {
    questions.lunaEffort = {
      criteria: {
        [KEEP]: `${lunaEffort} effort is enough`,
        ...Object.fromEntries(
          higher.map((effort) => [effort, EFFORT_CRITERIA[effort]])
        ),
      },
      instructions: `An AI assistant in Slack is about to handle the latest message in this conversation. It is currently set to ${lunaEffort} reasoning effort. Is it SURE that a higher effort is needed to do this well? Choose a higher level only if it clearly is; otherwise keep.`,
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
    const haiku = choiceSchema.safeParse(answers.effort).data;
    if (lunaEffort && haiku && isEffort(haiku.choice)) {
      const luna = choiceSchema.safeParse(answers.lunaEffort).data;
      const raiseTo =
        luna &&
        isEffort(luna.choice) &&
        (luna.probabilities[luna.choice] ?? 0) >= LUNA_RAISE_THRESHOLD
          ? luna.choice
          : undefined;
      effort = {
        haiku: haiku.choice,
        luna: raiseTo ?? lunaEffort,
        lunaRaised: raiseTo !== undefined,
        probabilities: {
          haiku: haiku.probabilities,
          ...(luna ? { luna: luna.probabilities } : {}),
        },
      };
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
