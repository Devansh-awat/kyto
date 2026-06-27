import { env } from '@/env';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

export type Complexity = 'simple' | 'complex';

// HackClub's OpenRouter-compatible proxy. gpt-oss-120b is free on this proxy,
// so classification costs nothing against the daily budget while staying fast.
const CLASSIFIER_URL = 'https://ai.hackclub.com/proxy/v1/chat/completions';
const CLASSIFIER_MODEL = 'openai/gpt-oss-120b';
const CLASSIFY_TIMEOUT_MS = 8000;
const MAX_INPUT_CHARS = 4000;

const SYSTEM_PROMPT = `You route requests for a Slack assistant that can write and run code in a sandbox, browse the web, and use many tools. Reply with EXACTLY one word: "complex" or "simple".
- "complex": coding, debugging, building or deploying, analyzing repos/files/URLs, multi-step tasks, or anything needing tools, the sandbox, or careful reasoning.
- "simple": greetings, small talk, short factual or quick questions, simple lookups.`;

/**
 * Classify a user request as "simple" or "complex" using a free model on
 * HackClub's proxy, so the agent can reserve the expensive premium model for
 * queries that need it. On any failure (or no HackClub key) we default to
 * "simple" — the budget-safe choice, since the simple chain still leads with a
 * strong coding model.
 */
export async function classifyComplexity(text: string): Promise<Complexity> {
  if (!env.HACKCLUB_API_KEY) {
    return 'simple';
  }
  try {
    const response = await fetch(CLASSIFIER_URL, {
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
        Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
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
