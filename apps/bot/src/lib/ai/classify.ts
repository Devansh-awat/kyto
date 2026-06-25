import { env } from '@/env';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

export type Complexity = 'simple' | 'complex';

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
// Free, high-quota (500/day) classifier — costs nothing against the HackClub
// budget, so routing never eats into the budget it is trying to protect.
const CLASSIFIER_MODEL = 'gemini-3.1-flash-lite';
const CLASSIFY_TIMEOUT_MS = 8000;
const MAX_INPUT_CHARS = 4000;

const SYSTEM_PROMPT = `You route requests for a Slack assistant that can write and run code in a sandbox, browse the web, and use many tools. Reply with EXACTLY one word: "complex" or "simple".
- "complex": coding, debugging, building or deploying, analyzing repos/files/URLs, multi-step tasks, or anything needing tools, the sandbox, or careful reasoning.
- "simple": greetings, small talk, short factual or quick questions, simple lookups.`;

/**
 * Classify a user request as "simple" or "complex" using a free Gemini model,
 * so the agent can reserve the expensive premium model for queries that need it.
 * On any failure (or no Gemini key) we default to "simple" — the budget-safe
 * choice, since the simple chain still leads with a strong coding model.
 */
export async function classifyComplexity(text: string): Promise<Complexity> {
  if (!env.GEMINI_API_KEY) {
    return 'simple';
  }
  try {
    const response = await fetch(GEMINI_URL, {
      body: JSON.stringify({
        max_tokens: 16,
        messages: [
          { content: SYSTEM_PROMPT, role: 'system' },
          { content: text.slice(0, MAX_INPUT_CHARS), role: 'user' },
        ],
        model: CLASSIFIER_MODEL,
        temperature: 0,
      }),
      headers: {
        Authorization: `Bearer ${env.GEMINI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`classifier HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const answer = data.choices?.[0]?.message?.content?.toLowerCase() ?? '';
    return answer.includes('complex') ? 'complex' : 'simple';
  } catch (error) {
    logger.warn(
      { err: errorMessage(error) },
      '[classify] failed, defaulting to simple'
    );
    return 'simple';
  }
}
