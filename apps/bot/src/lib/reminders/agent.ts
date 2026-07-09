import {
  type SandboxContext,
  streamAttempt,
  subagentAttempt,
  subagentSystemPrompt,
} from '@repo/ai';
import type { Reminder } from '@repo/db/queries';
import { LazySandbox } from '@repo/sandbox';
import { env } from '@/env';
import type { Message, ThreadHandle } from '@/harness';
import { requestHints } from '@/lib/ai/hints';
import { bot } from '@/lib/chat';
import logger from '@/lib/logger';
import { threadSandboxStore, withThreadSandbox } from '@/lib/sandbox/store';

// An agent reminder runs the SAME multi-step tool loop as a real turn, but
// headless: nothing is streamed to Slack, and its final text becomes the
// reminder's message. It is pinned to the cheap subagent model rather than the
// turn router, so an unattended job's cost stays predictable no matter what the
// reminder text asks for.
const RECURRING_JOB_NOTE = `

<recurring_job>
You are running as a recurring background job, not a live chat turn: there is no chat history, nobody to ask a follow-up question, and no memory of previous runs. Do the work, then let your final reply be exactly the message that should be posted — no preamble, no meta-commentary about being a scheduled job. Slack search (searchSlack) will not work here, as it needs a live user interaction to authorize it; prefer readConversationHistory, searchWeb, or bash.
</recurring_job>`;

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

/**
 * Run an agent reminder and return the text it decided to post.
 *
 * It reuses the persistent sandbox of the thread it was created in (holding
 * that thread's lock), so it can read files kyto wrote when the reminder was
 * set up. Without a `threadId` it gets its own throwaway sandbox.
 */
export async function runReminderAgent(reminder: Reminder): Promise<string> {
  const attempt = subagentAttempt;
  if (!attempt) {
    throw new Error(
      'No model is configured for agent reminders (needs GEMINI_API_KEY or OPENROUTER_API_KEY).'
    );
  }
  const run = () => runAgent(reminder, attempt);
  return reminder.threadId
    ? await withThreadSandbox(reminder.threadId, run)
    : await run();
}

async function runAgent(
  reminder: Reminder,
  attempt: NonNullable<typeof subagentAttempt>
): Promise<string> {
  // Where the job's tools act, and where an agent reminder without a channel
  // posts: the thread it was created in, else the user's DM.
  const thread: ThreadHandle = reminder.threadId
    ? bot.thread(reminder.threadId)
    : await bot.openDM(reminder.userId);
  const message = syntheticMessage(reminder, thread.id);

  const sandboxSession = new LazySandbox({
    apiKey: env.E2B_API_KEY,
    githubToken: env.GH_TOKEN,
    logger,
    // Sharing the thread's sandbox is the whole point: the job can use what the
    // model built earlier. Jobs without a thread get an unremembered sandbox.
    ...(reminder.threadId
      ? { sessionId: reminder.threadId, store: threadSandboxStore }
      : {}),
  });
  const sandboxContext: SandboxContext = {
    session: sandboxSession,
    sessionWorkDir: sandboxSession.workDir,
  };

  const { buildTools } = await import('@/lib/ai/toolset');
  let close: (() => Promise<void>) | undefined;
  try {
    const hints = await requestHints({ message, thread });
    const built = await buildTools({
      bot,
      getSandboxContext: () => sandboxContext,
      message,
      thread,
    });
    close = built.close;

    const result = streamAttempt({
      activeTools: built.activeTools,
      attempt,
      holder: {},
      prompt: reminder.text,
      system: `${subagentSystemPrompt({ hints })}${RECURRING_JOB_NOTE}`,
      tools: built.tools,
    });

    let text = '';
    let toolCalls = 0;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
      } else if (part.type === 'tool-call') {
        toolCalls += 1;
      }
    }
    const reply = text.trim();
    if (reply) {
      return reply;
    }
    if (toolCalls > 0) {
      return '_(Completed scheduled actions with no additional message.)_';
    }
    throw new Error('Agent reminder produced an empty response.');
  } finally {
    await close?.().catch(() => undefined);
    await sandboxSession.destroy().catch(() => undefined);
  }
}
