// Anti-coding: kyto answers code questions like any AI chatbot — explain, write
// a snippet, fix code someone pasted — but it is not an autonomous coding agent
// on Hack Club AI's shared budget.
//
// Hack Club AI's abuse tooling flagged kyto's key for coding-agent traffic
// (2026-09, someone had it bot cap.js and fork itself), and HCAI's answer was
// "system prompt + Jev". This is the Jev half: every message is scored before
// its turn runs. The prompt half lives in packages/ai/src/prompts/core.ts, and
// the toolset drops `deploySite` on the same turns.
//
// The rules (owner's call, 2026-09-26): a stranger is stopped and warned, and
// caught again within a day is banned for two hours; the owner gets an ephemeral
// note and the turn runs anyway; someone on their own model key is never warned,
// but that one turn is kept off kyto's shared models entirely.

import { recordCodingWarning } from '@repo/db/queries';
import { z } from 'zod';
import { env } from '@/env';
import type { Message, ThreadHandle } from '@/harness';
import { banUser } from '@/lib/bans';
import { formatBanDuration } from '@/lib/bans/duration';
import { byokConfigured } from '@/lib/byok/crypto';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { CODING_BAN_MS, decideCodingAction, isRepeatOffence } from './decide';

const JEV_URL = 'https://ai.hackclub.com/proxy/v1/jev/systemone';

// Jev answers in a few hundred ms. Past this the turn goes ahead unscored rather
// than making every message wait on a slow classifier.
const JEV_TIMEOUT_MS = 4000;

// Jev bills per input token; a pasted log does not need to be read in full to
// tell whether it came with "fix this for me".
const MAX_STATE_CHARS = 4000;

// Worded around what kyto MAY do as much as what it may not. The line is the
// owner's: fixing code someone pasted, in the reply, is what any AI chatbot does
// and is fine; what got kyto's key flagged was AGENTIC work — ~20 minutes of it
// botting cap.js, and forking itself. An early draft that asked only "is this
// about code?" flagged "why does my loop print undefined".
const CODING_QUESTION = {
  criteria: {
    false:
      'A normal chatbot coding question: explain, snippet, or fix pasted code in the reply; or not about code',
    true: 'Wants the assistant to autonomously build, run, automate, bot a site, work in a repo, or deploy',
  },
  instructions:
    'A Slack chatbot may answer coding questions like any AI chatbot: explain code, write a snippet or a short function, and fix code the user pasted by replying with the corrected version. It must NOT act as an autonomous coding agent. Is this message asking it to act as a coding agent: automate, bot, scrape or farm a website or service; bypass or solve captchas or anti-bot protection; build and RUN a program, bot or project in its own sandbox; work through a codebase or repository; clone, fork, commit, push or open a pull request; copy or fork itself; or deploy/host something?',
  type: 'noul',
} as const;

const jevResponseSchema = z.object({
  answers: z.object({
    coding: z.object({ noul: z.number().min(0).max(1) }),
  }),
  model: z.string().optional(),
});

/** Jev's probability that this text asks for coding-agent work, or null if it
 * could not be scored (the caller fails open). */
async function scoreCodingRequest(text: string): Promise<number | null> {
  const state = text.trim().slice(0, MAX_STATE_CHARS);
  if (!state) {
    return null;
  }
  try {
    const response = await fetch(JEV_URL, {
      body: JSON.stringify({ questions: { coding: CODING_QUESTION }, state }),
      headers: {
        Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        {
          body: (await response.text().catch(() => '')).slice(0, 300),
          status: response.status,
        },
        '[anti-coding] jev refused; letting the turn through'
      );
      return null;
    }
    const parsed = jevResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues },
        '[anti-coding] unexpected jev response; letting the turn through'
      );
      return null;
    }
    return parsed.data.answers.coding.noul;
  } catch (error) {
    logger.warn(
      toLogError(error),
      '[anti-coding] jev call failed; letting the turn through'
    );
    return null;
  }
}

export interface CodingGate {
  /** Kept to the user's own models for this turn — no shared fallback. */
  ownModelsOnly: boolean;
  /** The turn must not run; the person has already been told why. */
  stop: boolean;
}

/**
 * Score the message and act on it. Tells the person itself — the caller only
 * has to honour `stop` and `ownModelsOnly`.
 */
export async function gateCodingRequest({
  isOwner,
  message,
  secret,
  thread,
  usesOwnModels,
}: {
  isOwner: boolean;
  message: Message;
  /** A `!secret` turn: anything said about it must stay ephemeral. */
  secret: boolean;
  thread: ThreadHandle;
  usesOwnModels: boolean;
}): Promise<CodingGate> {
  const probability = await scoreCodingRequest(message.text);
  const decision = decideCodingAction({ isOwner, probability, usesOwnModels });
  const userId = message.author.userId;
  if (decision !== 'allow') {
    logger.info(
      { decision, probability, threadId: thread.id, userId },
      '[anti-coding] coding request caught'
    );
  }
  if (decision === 'allow') {
    return { ownModelsOnly: false, stop: false };
  }
  if (decision === 'own-models-only') {
    return { ownModelsOnly: true, stop: false };
  }
  if (decision === 'owner-warning') {
    await tell({
      ephemeral: true,
      message,
      text: "heads up: that reads as a coding-agent request. you're the owner so it runs anyway, but on Hack Club AI's key this is the kind of traffic their abuse tooling flags.",
      thread,
    });
    return { ownModelsOnly: false, stop: false };
  }

  const now = new Date();
  // A DB failure must not ban anyone: treat it as a first offence.
  const previousWarning = await recordCodingWarning(userId).catch(
    (error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId },
        '[anti-coding] could not record the warning'
      );
      return null;
    }
  );
  const ownKeyHint = byokConfigured()
    ? ' if you want a coding agent, add your own model key in my App Home (Model keys) and this limit no longer applies to you.'
    : '';
  if (isRepeatOffence({ now, previousWarning })) {
    await banUser({
      bannedBy: 'anti-coding',
      ms: CODING_BAN_MS,
      reason:
        'asked kyto to act as a coding agent again within a day of being warned (automatic)',
      userId,
    });
    await tell({
      ephemeral: secret,
      message,
      text: `<@${userId}> that's a second coding-agent request within a day of your warning, so you're banned from kyto for ${formatBanDuration(CODING_BAN_MS)}.${ownKeyHint}`,
      thread,
    });
    return { ownModelsOnly: false, stop: true };
  }
  await tell({
    ephemeral: secret,
    message,
    text: `<@${userId}> i'm not a coding agent — i'll explain code, write a snippet or fix code you paste, but i won't build and run projects, automate or bot sites, work in repos or deploy things for you. this is your warning: asking again within 24 hours gets you a ${formatBanDuration(CODING_BAN_MS)} ban.${ownKeyHint}`,
    thread,
  });
  return { ownModelsOnly: false, stop: true };
}

async function tell({
  ephemeral,
  message,
  text,
  thread,
}: {
  ephemeral: boolean;
  message: Message;
  text: string;
  thread: ThreadHandle;
}): Promise<void> {
  const sent = ephemeral
    ? thread.postEphemeral(message.author, text, { fallbackToDM: false })
    : thread.post({ markdown: text });
  await sent.catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), threadId: thread.id },
      '[anti-coding] could not deliver the warning'
    );
  });
}
