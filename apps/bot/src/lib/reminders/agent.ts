import {
  type SandboxContext,
  SKIP_TOOL_NAME,
  streamAttempt,
  subagentAttempt,
  subagentSystemPrompt,
} from '@repo/ai';
import type { Reminder } from '@repo/db/queries';
import { LazySandbox } from '@repo/sandbox';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { ThreadHandle } from '@/harness/thread';
import type { Message } from '@/harness/types';
import { requestHints } from '@/lib/ai/hints';
import { stripToolComplaints } from '@/lib/ai/stream/tool-complaints';
import { pickPreloadTools } from '@/lib/ai/tool-preload';
import { bot } from '@/lib/chat';
import { sandboxKey } from '@/lib/code-channels';
import logger from '@/lib/logger';
import { openSandboxProxies } from '@/lib/sandbox/proxies';
import { threadSandboxStore, withThreadSandbox } from '@/lib/sandbox/store';

// An agent reminder runs the SAME multi-step tool loop as a real turn, but
// headless: nothing is streamed to Slack, and its final text becomes the
// reminder's message. It is pinned to the cheap subagent model rather than the
// turn router, so an unattended job's cost stays predictable no matter what the
// reminder text asks for.
//
// The job is told WHERE its reply lands and that the reply IS the post: a daily
// digest told "post nothing if there's nothing new" answered "nothing new, not
// posting anything" — and that sentence was then posted to #kyto, because the
// job never knew its final text was a Slack message. `skip` is how it stays quiet.
// The note is the cached static half of the system prompt, so the destination
// itself rides in the prompt (`<output_destination>`), never in here.
const RECURRING_JOB_NOTE = `

<recurring_job>
You are running as a recurring background job, not a live chat turn: there is no chat history, nobody to ask a follow-up question, and no memory of previous runs.

NOBODY IS WATCHING THIS RUN. Do not ask questions, do not offer choices, and do not wait for confirmation — there is nobody there to answer, and a question posted here just reads as the job failing. If something needs doing and you are allowed to do it, DO IT, then say what you did. If you genuinely cannot proceed, say what blocked you and what you need — as a statement, not a question.

WHERE YOUR OUTPUT GOES: your final reply is posted verbatim, as a new message, to the place named in <output_destination> after the job. It IS the message people there will read — so write it as that message: no preamble, no "as you asked", no meta-commentary about being a scheduled job, and never a sentence claiming you posted nothing (writing it posts it).
- If you post the report yourself with postMessage to that same place, do not repeat it: call skip.
- If the job's instructions say to stay silent in some case (e.g. nothing new), and that case applies, call skip instead of writing anything. Skip posts nothing at all.
- Otherwise leave a report. Even a run where nothing happened should say so ("checked X, nothing new since the last run") unless the job says to stay silent.

Many tools are deferred: if the job needs one you do not see (e.g. gh for GitHub), load it with loadTools — never report that a tool is missing without trying.

Slack search (searchSlack) will not work here, as it needs a live user interaction to authorize it; prefer readConversationHistory, searchWeb, or bash.
</recurring_job>`;

// Asked of the same model when a run did work but wrote nothing. It keeps its
// REAL tools: an empty toolset contradicted the system prompt above it and weak
// models narrated that ("no tools loaded") straight into the posted message
// (owner's call 2026-08-22). So this says only what to DO, and never names tools
// at all — naming the thing you forbid is how it kept ending up in the output.
// stripToolComplaints is the backstop.
//
// It is a NEW call with no memory of the run, so it is handed the run's own
// actions: without them it told #kyto it had posted nothing, right under the
// report it had just posted.
function reportNudge(actions: string[]): string {
  return `You already ran the job above. This is exactly what you did, in order:\n<what_you_did>\n${actions.join('\n')}\n</what_you_did>\n\nYou never wrote the final message. Write it now, from what you did: what you checked, what you found, and anything you changed or posted. This message is prose only: do not start new work, and do not describe your setup or environment. If what you did already covers it (you posted the report where this lands) or the job says to stay silent here, call skip instead.`;
}

/** The reminder's owner, as the author of the synthetic message driving it. */
function syntheticMessage(reminder: Reminder, threadId: string): Message {
  return {
    attachments: [],
    author: { userId: reminder.userId, userName: reminder.userId },
    id: `reminder-${reminder.id}-${Date.now()}`,
    isMention: false,
    metadata: { dateSent: new Date() },
    raw: {},
    text: reminder.text,
    threadId,
  };
}

// A job told to "report to #kyto" posts its report there itself, and the
// scheduler then posted the job's closing summary ("Reported to #kyto: …")
// into the same channel — the owner's daily repo digest arrived as two posts.
// A stalled stream used to hang the run forever: the reminder stayed in-flight
// (never fired again until a restart) and held the thread's sandbox lock.
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const REPORT_TIMEOUT_MS = 3 * 60 * 1000;
const postResultSchema = z.looseObject({ success: z.boolean().optional() });
const postInputSchema = z.looseObject({ id: z.string() });
const CONVERSATION_ID = /[CDG][A-Z0-9]{6,}/;
const USER_ID = /[UW][A-Z0-9]{6,}/;
const ACTION_PREVIEW_CHARS = 300;
const MAX_ACTIONS = 40;

const preview = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? '').replace(/\s+/g, ' ').slice(0, ACTION_PREVIEW_CHARS);
};

/**
 * Run an agent reminder and return the text it decided to post — or null when
 * the job skipped, or already posted into the conversation the reminder lands
 * in, so a second message there would only repeat it.
 *
 * It reuses the persistent sandbox of the thread it was created in (holding
 * that thread's lock), so it can read files kyto wrote when the reminder was
 * set up. Without a `threadId` it gets its own throwaway sandbox.
 */
export async function runReminderAgent(
  reminder: Reminder
): Promise<string | null> {
  const attempt = subagentAttempt;
  if (!attempt) {
    throw new Error(
      'No model is configured for agent reminders (the subagent roster is empty).'
    );
  }
  const run = () => runAgent(reminder, attempt);
  return reminder.threadId
    ? await withThreadSandbox(reminder.threadId, run)
    : await run();
}

/**
 * Second chance at the message: same model, its real tools still registered,
 * "write the report you skipped". Best-effort — a failure here just falls through
 * to the caller's placeholder, which is still better than the run being silent.
 */
async function synthesizeReport({
  actions,
  attempt,
  built,
  hints,
  prompt,
  reminderId,
}: {
  actions: string[];
  attempt: NonNullable<typeof subagentAttempt>;
  built: { activeTools: () => string[]; tools: ToolSet };
  hints: Awaited<ReturnType<typeof requestHints>>;
  prompt: string;
  reminderId: string;
}): Promise<string | null | undefined> {
  try {
    const result = streamAttempt({
      abortSignal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      activeTools: built.activeTools,
      attempt,
      holder: {},
      prompt: `${prompt}\n\n${reportNudge(actions)}`,
      system: subagentSystemPrompt({ hints, note: RECURRING_JOB_NOTE }),
      tools: built.tools,
    });
    let text = '';
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
      } else if (
        part.type === 'tool-call' &&
        part.toolName === SKIP_TOOL_NAME
      ) {
        return null;
      }
    }
    // This report is posted verbatim as the reminder's message, so a sentence
    // about tools being missing must never survive into it.
    return stripToolComplaints(text).trim() || undefined;
  } catch (error) {
    logger.warn({ err: error, reminderId }, '[reminders] report nudge failed');
    return;
  }
}

async function runAgent(
  reminder: Reminder,
  attempt: NonNullable<typeof subagentAttempt>
): Promise<string | null> {
  // Where the job's tools act: the thread it was created in, else the user's DM.
  // Not where its message lands — the scheduler posts that to `channelId`, else
  // the creator's DM.
  const thread: ThreadHandle = reminder.threadId
    ? bot.thread(reminder.threadId)
    : await bot.openDM(reminder.userId);
  const message = syntheticMessage(reminder, thread.id);

  // A fresh proxy token for this fire (the creating turn's was revoked long
  // ago), so the job's bash/slackScript tools can read Slack.
  const proxies = openSandboxProxies({
    isOwner: reminder.userId === env.OWNER_USER_ID,
    ...(reminder.threadId ? { threadId: reminder.threadId } : {}),
    userId: reminder.userId,
  });
  const sandboxSession = new LazySandbox({
    apiKey: env.E2B_API_KEY,
    bootstrapCommand: proxies.bootstrapCommand,
    env: proxies.env,
    logger,
    // Sharing the thread's sandbox is the whole point: the job can use what the
    // model built earlier. Jobs without a thread get an unremembered sandbox.
    ...(reminder.threadId
      ? {
          sessionId: await sandboxKey(reminder.threadId),
          store: threadSandboxStore,
        }
      : {}),
  });
  const sandboxContext: SandboxContext = {
    session: sandboxSession,
    sessionWorkDir: sandboxSession.workDir,
    suspendSlack: proxies.suspendSlack,
  };

  const { buildTools } = await import('@/lib/ai/toolset');
  let close: (() => Promise<void>) | undefined;
  try {
    // The tools a job names are deferred behind loadTools, and an unattended
    // run has no live turn to preload them: the daily repo digest, told to "use
    // the gh tool", never saw gh and reported it had no way to check the repo.
    // Same Jev preload a live turn gets, plus any tool the job names outright.
    const [hints, built, preload] = await Promise.all([
      requestHints({ message, thread }),
      buildTools({
        bot,
        getSandboxContext: () => sandboxContext,
        message,
        thread,
        // A reminder fires on a schedule with nobody watching, so an MCP tool
        // set to ask permission refuses here rather than posting a button and
        // blocking the run for ten minutes on a click that may never come.
        unattended: true,
      }),
      pickPreloadTools(reminder.text),
    ]);
    close = built.close;
    const words = new Set(reminder.text.match(/[\w-]+/g) ?? []);
    built.preload([
      ...preload.tools,
      ...Object.keys(built.tools).filter((name) => words.has(name)),
    ]);

    const prompt = `${reminder.text}\n\n<output_destination>${
      reminder.channelId
        ? `the channel <#${reminder.channelId}> (id ${reminder.channelId}), as a new top-level message`
        : `a DM to <@${reminder.userId}> (id ${reminder.userId}), the person who set this job up`
    }</output_destination>`;
    const result = streamAttempt({
      abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      activeTools: built.activeTools,
      attempt,
      holder: {},
      prompt,
      system: subagentSystemPrompt({ hints, note: RECURRING_JOB_NOTE }),
      tools: built.tools,
    });

    // A post by the job itself to where the reminder's own message lands: the
    // channel, or for a DM reminder a postMessage to the creator.
    const postedHere = (input: unknown): boolean => {
      const target = postInputSchema.safeParse(input).data?.id;
      if (!target) {
        return false;
      }
      return reminder.channelId
        ? target.match(CONVERSATION_ID)?.[0] === reminder.channelId
        : target.match(USER_ID)?.[0] === reminder.userId;
    };
    let text = '';
    const actions: string[] = [];
    let postedToDestination = false;
    let skipped = false;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
      } else if (part.type === 'tool-call') {
        if (part.toolName === SKIP_TOOL_NAME) {
          skipped = true;
        }
        if (actions.length < MAX_ACTIONS) {
          actions.push(`- called ${part.toolName}: ${preview(part.input)}`);
        }
      } else if (part.type === 'tool-result') {
        const failed =
          postResultSchema.safeParse(part.output).data?.success === false;
        if (actions.length < MAX_ACTIONS) {
          actions.push(
            `  -> ${failed ? 'FAILED: ' : ''}${preview(part.output)}`
          );
        }
        if (part.toolName === 'postMessage' && !failed) {
          postedToDestination ||= postedHere(part.input);
        }
      }
    }
    if (skipped) {
      logger.info(
        { reminderId: reminder.id },
        '[reminders] the job skipped; posting nothing'
      );
      return null;
    }
    if (postedToDestination) {
      logger.info(
        { reminderId: reminder.id },
        '[reminders] the job posted its own report where the reminder lands; not posting a second'
      );
      return null;
    }
    const reply = text.trim();
    if (reply) {
      return reply;
    }
    if (actions.length > 0) {
      // The job did real work and then said nothing, which used to post
      // "(Completed scheduled actions with no additional message.)" — a line
      // that tells its reader precisely nothing about what happened. Ask the
      // same model to write the report it skipped, keeping its real tools so it
      // does not narrate an empty toolset into the posted message. Same nudge
      // the live agent loop uses.
      const nudged = await synthesizeReport({
        actions,
        attempt,
        built,
        hints,
        prompt,
        reminderId: reminder.id,
      });
      if (nudged !== undefined) {
        return nudged;
      }
      logger.warn(
        { reminderId: reminder.id },
        '[reminders] agent job did work but produced no report, even after a nudge'
      );
      return '_(Ran the scheduled job — it completed its actions but did not write a report.)_';
    }
    throw new Error('Agent reminder produced an empty response.');
  } finally {
    proxies.revoke();
    await close?.().catch(() => undefined);
    await sandboxSession.destroy().catch(() => undefined);
  }
}
