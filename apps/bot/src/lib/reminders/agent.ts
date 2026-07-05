import {
  createAgent,
  geminiAttempt,
  openSession,
  type SandboxContext,
  systemPrompt,
} from '@repo/ai';
import type { Reminder } from '@repo/db/queries';
import { loadSkills } from '@repo/sandbox';
import { Message, root } from 'chat';
import { runAsRecurringJob } from '@/lib/agent/resolved-model';
import { sandbox } from '@/lib/agent/sandbox';
import { requestHints } from '@/lib/ai/hints';
import { buildTools } from '@/lib/ai/toolset';
import { bot } from '@/lib/chat';

// Recurring 'agent' reminders run through the SAME Pi harness as a normal chat
// turn — full sandbox, full tool set (search, canvas, pins, sites, etc.) — so
// it can genuinely "do all kyto can", not just fetch one URL. The one
// deliberate difference from a normal turn: the model is PINNED to the
// owner's own Gemini key (never openrouter/auto/HackClub), so an unattended
// job's cost stays predictable regardless of what the reminder text asks for.
const REMINDER_AGENT_MODEL = 'gemini-3.1-flash-lite';

const RECURRING_JOB_NOTE = `

<recurring_job>
You are running as a recurring background job, not a live chat turn: there is no chat history, no user available to ask follow-up questions, and no memory of past runs. Complete the instructions and let your final reply be exactly what should be posted — no preamble, no meta-commentary about being a scheduled job. Note: Slack search (searchSlack) may not work here since there is no live user interaction backing it; prefer searchWeb or other tools when possible.
</recurring_job>`;

function syntheticMessage({
  reminder,
  threadId,
}: {
  reminder: Reminder;
  threadId: string;
}): Message {
  return new Message({
    attachments: [],
    author: {
      fullName: 'Recurring reminder',
      isBot: false,
      isMe: false,
      userId: reminder.userId,
      userName: reminder.userId,
    },
    formatted: root([]),
    id: `reminder-${reminder.id}-${Date.now()}`,
    metadata: { dateSent: new Date(), edited: false },
    raw: undefined,
    text: reminder.text,
    threadId,
  });
}

/** Post a small marker to mint a fresh thread in the target channel, so the
 * harness has a real Thread to run tools against and post into. */
async function mintChannelThread(channelId: string) {
  const sent = await bot
    .channel(channelId)
    .post({ markdown: '_Running a recurring agent task…_' });
  return bot.thread(sent.threadId);
}

export async function runReminderAgent(reminder: Reminder): Promise<string> {
  const thread = reminder.channelId
    ? await mintChannelThread(reminder.channelId)
    : await bot.openDM(reminder.userId);

  const message = syntheticMessage({ reminder, threadId: thread.id });
  const hints = await requestHints({ message, thread });
  const skills = await loadSkills();

  let sandboxContext: SandboxContext | undefined;
  const tools = buildTools({
    bot,
    getSandboxContext: () => sandboxContext,
    message,
    thread,
  });

  const agent = createAgent({
    attempt: geminiAttempt(REMINDER_AGENT_MODEL),
    onSandboxReady: (context) => {
      sandboxContext = context;
    },
    sandbox,
    sessionId: thread.id,
    skills,
    systemPrompt: `${systemPrompt({ hints })}${RECURRING_JOB_NOTE}`,
    tools,
  });

  const session = await openSession({ agent, threadId: thread.id });
  try {
    // Marks this async branch so the auto-router (if this pinned Gemini
    // attempt ever falls back to it) biases toward the cheapest tier — see
    // resolved-model.ts's RECURRING_JOB_COST_QUALITY_TRADEOFF.
    const result = await runAsRecurringJob(() =>
      agent.generate({ prompt: reminder.text, session })
    );
    const text = result.text.trim();
    if (text) {
      return text;
    }
    if (result.toolCalls.length > 0) {
      return '_(Completed scheduled actions with no additional message.)_';
    }
    throw new Error('Agent reminder produced an empty response.');
  } finally {
    await session.destroy().catch(() => undefined);
  }
}
