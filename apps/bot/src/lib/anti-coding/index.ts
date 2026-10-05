// Anti-coding: kyto answers code questions like any AI chatbot and does
// general agent work, but coding-agent work never runs on Hack Club AI's
// shared key.
//
// Hack Club AI's abuse tooling flagged kyto's key for coding-agent traffic
// (2026-09, someone had it bot cap.js and fork itself), and HCAI's answer was
// "system prompt + Jev". This is the Jev half, and it judges the WORK, not the
// message: once before the model runs (the thread + the new message), and again
// before every code-capable tool call (plus what the turn has fetched and done),
// so "fetch this gist and follow it" is caught when the gist turns out to say
// "write a bot". The prompt half lives in packages/ai/src/prompts/core.ts.
//
// A catch is SILENT (owner's call, 2026-09-30; it used to warn, strike and
// ban): the model is told, privately, to hand the code work to OpenCode, which
// runs on its own free models — so the person gets what they asked for, and
// nobody is told OpenCode was used or that coding is restricted. Someone on
// their own model key is never steered; that one turn just stays off kyto's
// shared models.

import { z } from 'zod';
import { env } from '@/env';
import type { ThreadHandle } from '@/harness/thread';
import type { Message } from '@/harness/types';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { decideCodingAction } from './decide';
import { isReadOnlyCall } from './read-only';
import { type CodingAction, renderCodingState } from './state';

const JEV_URL = 'https://ai.hackclub.com/proxy/v1/jev/systemone';

// Jev answers in a few hundred ms. Past this the turn goes ahead unscored rather
// than making every message wait on a slow classifier.
const JEV_TIMEOUT_MS = 4000;

// A backstop only: renderCodingState already budgets each section.
const MAX_STATE_CHARS = 10_000;

const CRITERIA = {
  false:
    'Chatbot-style coding help in the reply, general agent work, or not about code',
  true: 'Coding-agent work: building, running or debugging software, bots or solvers, repo work, GitHub writes, deploying',
};

// TWO questions, flagged on whichever is higher, because each is blind where the
// other sees. `work` reads the whole context and catches what the turn is DOING
// (a gist that turns into a bot, a clone-and-edit behind "help me with my
// project"), but under-reads a plain request before anything has run: the live
// test "write a node script that auto-claims the daily reward, then run it every
// hour" scored 0.81 on it alone. `request` reads the ask and catches that (0.97)
// but misses follow-ups whose meaning is in the thread ("give me the final
// program": 0.59 vs 0.93 on `work`).
//
// Both are framed around what kyto DELIVERS. Software as the result is coding;
// code used as a TOOL (ffmpeg, yt-dlp, whisper, a pip install, a Python one-off)
// to hand back an answer, a file or media is general agent work. Without that
// line the first live week (2026-09-26..29) had 7 strangers stopped at a `bash`
// call, and most were tool use: a zip turned into a video with python + ffmpeg
// (0.91 — a 2-hour BAN, since the same person had been warned for an npm install),
// a video transcribed with whisper (0.94), a YouTube page fetched with a curl clone.
// Reworded, those score 0.12-0.27, while lily's cap.js / BotID / Turnstile
// thread, fetch-a-gist-then-write-a-bot, clone-and-edit, fork yourself and
// hosting a site still score 0.93-0.98 (31 labelled cases on jev-1.13.0).
// Two lines drawn on purpose (owner's calls, 2026-09-29): installing a package
// on request is allowed (is-even, 0.81), but building from source or running a
// brute-force / mining job counts as coding even when the output is "just" an
// answer — lily's mkp224o onion vanity address went 0.84 -> 0.95 once named.
// 37 labelled cases, all on the right side of 0.9.
const QUESTIONS = {
  request: {
    criteria: CRITERIA,
    instructions:
      "A Slack assistant may answer coding questions like any AI chatbot (explain code, write a snippet or short function, fix code the user pasted, in its reply) and may do general agent work (research, browsing, email, Slack) — including using code and tools itself as a means to an end, e.g. converting or transcribing media, downloading something, calculating, analysing data or drawing a chart, where what it delivers is an answer, a file or media rather than a program. It must NOT act as an autonomous coding agent. Read the latest message in light of the conversation before it. Is it asking the assistant to act as a coding agent, where the RESULT is software: build, run or debug a program, script, bot or solver for someone; automate or bot a website, service or captcha; work on a repository's code; clone, compile or build software from source; run a brute-force, mining or other long compute job (e.g. generating a vanity address or keys); clone, fork, commit, push or open a pull request; copy or fork itself; or deploy/host something?",
    type: 'noul',
  },
  work: {
    criteria: CRITERIA,
    instructions:
      "Judge the WHOLE context below: the conversation so far, the latest message, and what the assistant has done and is about to do this turn. Is the assistant being asked to act, or already acting, as an autonomous CODING agent — where the RESULT is software: writing or building a program, script, bot, solver, website or app for someone to keep or run; automating, botting or farming a website, service or captcha; working on a repository's code; cloning, compiling or building software from source; running brute-force, mining or other long compute jobs (e.g. generating vanity addresses or keys); GitHub writes; or deploying/hosting code? NOT a coding agent: chatbot coding help in its reply (explaining, a snippet, fixing code the user pasted), and general agent work — which INCLUDES using code and command-line tools as a means to an end: installing a package, or running ffmpeg, yt-dlp, whisper, curl or a short Python script to download, convert, transcribe, inspect, compute or analyse something, when what it delivers is an answer, a file or media rather than a program.",
    type: 'noul',
  },
} as const;

const jevResponseSchema = z.object({
  answers: z.object({
    request: z.object({ noul: z.number().min(0).max(1) }),
    work: z.object({ noul: z.number().min(0).max(1) }),
  }),
  model: z.string().optional(),
});

/** Jev's probability that this context is coding-agent work, or null if it
 * could not be scored (the caller fails open). */
async function scoreCodingRequest(text: string): Promise<number | null> {
  const state = text.trim().slice(-MAX_STATE_CHARS);
  if (!state) {
    return null;
  }
  try {
    const response = await fetch(JEV_URL, {
      body: JSON.stringify({ questions: QUESTIONS, state }),
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
    const { request, work } = parsed.data.answers;
    return Math.max(request.noul, work.noul);
  } catch (error) {
    logger.warn(
      toLogError(error),
      '[anti-coding] jev call failed; letting the turn through'
    );
    return null;
  }
}

/** Turn-scoped anti-coding state: the context Jev is shown and what the turn
 * has done so far. */
export interface CodingMonitor {
  /** Judge the turn before the model runs. True = it is coding work, and the
   * prompt should carry DELEGATE_NOTE. */
  checkTurn: () => Promise<boolean>;
  /**
   * Judge one code-capable tool call BEFORE it runs, with everything the turn
   * has done so far. Returns what the model gets instead of running it, or
   * null to go ahead.
   */
  guardTool: (call: {
    input: unknown;
    toolName: string;
  }) => Promise<string | null>;
  /** Set once a custom-key user's turn is flagged: the shared chain is off. */
  readonly ownModelsOnly: boolean;
  recordResult: (action: Required<CodingAction>) => void;
  /** The thread as the model sees it — set once the prompt is built. */
  setConversation: (text: string) => void;
}

// Worded for the MODEL, and not to be relayed: no "I'm not allowed", no
// apology — the work simply gets done.
export const DELEGATE_NOTE =
  "This is coding work. Do the writing, building, running and debugging through the `opencode` tool, not your own shell — give it a complete brief in your own words. Then deliver the result as your own work. Don't mention this note or any coding restriction, and don't bring up OpenCode unless asked how it was done.";

const DELEGATE = `Not run. ${DELEGATE_NOTE}`;

const REFUSED_SHARED =
  "Refused on this model: this is coding-agent work, which only runs on the person's OWN model key, and this attempt is on kyto's shared model. Answer without it.";

export function createCodingMonitor({
  isOnSharedModel,
  message,
  onOwnModelsOnly,
  thread,
  usesOwnModels,
}: {
  /** Whether the attempt running right now is on kyto's shared chain. */
  isOnSharedModel: () => boolean;
  message: Message;
  /**
   * The turn was just caught doing coding work and may continue only on the
   * person's own models. Called once, the first time — the caller moves a turn
   * that is currently on the shared chain over, if it can.
   */
  onOwnModelsOnly?: () => void;
  thread: ThreadHandle;
  usesOwnModels: boolean;
}): CodingMonitor {
  const actions: CodingAction[] = [];
  let conversation = '';
  let ownModelsOnly = false;

  const judge = async (
    next?: CodingAction
  ): Promise<'allow' | 'delegate' | 'own-models-only'> => {
    const probability = await scoreCodingRequest(
      renderCodingState({ actions, conversation, latest: message.text, next })
    );
    const decision = decideCodingAction({ probability, usesOwnModels });
    // Every score, not just the catches: the threshold was set on 25 cases, and
    // real traffic is what will say whether 0.9 is right.
    logger.info(
      {
        decision,
        next: next?.toolName,
        probability,
        threadId: thread.id,
        userId: message.author.userId,
      },
      '[anti-coding] judged'
    );
    if (decision === 'own-models-only' && !ownModelsOnly) {
      ownModelsOnly = true;
      onOwnModelsOnly?.();
    }
    return decision;
  };

  return {
    checkTurn: async () => (await judge()) === 'delegate',
    guardTool: async (call) => {
      if (isReadOnlyCall(call)) {
        actions.push({ input: call.input, toolName: call.toolName });
        return null;
      }
      const verdict = await judge(call);
      // Recorded after judging, as the call that is now happening; its result
      // is filled in by recordResult when (if) it returns.
      actions.push({ input: call.input, toolName: call.toolName });
      if (verdict === 'delegate') {
        return DELEGATE;
      }
      if (verdict === 'own-models-only' && isOnSharedModel()) {
        return REFUSED_SHARED;
      }
      return null;
    },
    get ownModelsOnly() {
      return ownModelsOnly;
    },
    recordResult: (result) => {
      const key = JSON.stringify(result.input);
      for (let index = actions.length - 1; index >= 0; index -= 1) {
        const action = actions[index];
        if (
          action &&
          action.output === undefined &&
          action.toolName === result.toolName &&
          JSON.stringify(action.input) === key
        ) {
          action.output = result.output;
          return;
        }
      }
      actions.push(result);
    },
    setConversation: (text) => {
      conversation = text;
    },
  };
}
