import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Reminder } from '@repo/db/queries';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { fetchUrlText } from '@/lib/ai/tools/url';
import { errorMessage } from '@/lib/utils/error';

// Recurring 'agent' reminders run on the owner's own Gemini key, deliberately
// on the cheapest reachable model (not the main HackClub router) — they fire
// unattended, so cost must stay predictable regardless of how the owner
// phrases the reminder text. This is a plain single generateText call, not the
// full Pi harness: no sandbox, no session, just one small tool for fetching a
// URL if the instructions need current information.
const REMINDER_AGENT_MODEL = 'gemini-3.1-flash-lite';
const REMINDER_AGENT_MAX_STEPS = 4;

const AGENT_SYSTEM_PROMPT =
  'You are a small background agent running on a recurring schedule with no chat history, no user to ask follow-up questions, and no memory of past runs. Complete the instructions below and reply with ONLY the final message to post — no preamble, no meta-commentary about being an agent or about the schedule. Use fetchUrl if the instructions require current information from a URL. Keep the reply concise and suitable to post directly as a Slack message.';

export async function runReminderAgent(reminder: Reminder): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('Agent reminders require GEMINI_API_KEY to be configured.');
  }

  const gemini = createOpenAICompatible({
    apiKey: env.GEMINI_API_KEY,
    baseURL:
      env.GEMINI_BASE_URL ??
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    name: 'gemini',
  });

  const { text } = await generateText({
    model: gemini.languageModel(REMINDER_AGENT_MODEL),
    prompt: reminder.text,
    stopWhen: stepCountIs(REMINDER_AGENT_MAX_STEPS),
    system: AGENT_SYSTEM_PROMPT,
    tools: {
      fetchUrl: tool({
        description: 'Fetch the text content of a URL.',
        execute: async ({ url }) => {
          try {
            return await fetchUrlText(url);
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: z.object({
          url: z.string().url().describe('The URL to fetch.'),
        }),
      }),
    },
  });

  const result = text.trim();
  if (!result) {
    throw new Error('Agent reminder produced an empty response.');
  }
  return result;
}
