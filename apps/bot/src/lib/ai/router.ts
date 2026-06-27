import { CATALOG_IDS, DEFAULT_MODEL, MODEL_CATALOG } from '@repo/ai';
import { env } from '@/env';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// The router runs on a cheap, fast model; the MAIN query then runs on whatever
// paid catalog model the router picks (see MODEL_CATALOG in providers/pi.ts).
// Must be a NON-reasoning instruct model: reasoning models burn the tiny token
// budget on hidden thinking and return empty content. mistral-small follows the
// "reply with only the id" instruction reliably at ~0.5s and ~$0.07/1M.
const ROUTER_URL = 'https://ai.hackclub.com/proxy/v1/chat/completions';
const ROUTER_MODEL = 'mistralai/mistral-small-3.2-24b-instruct';
const ROUTER_TIMEOUT_MS = 8000;
const MAX_INPUT_CHARS = 4000;

const CATALOG_BLURBS = MODEL_CATALOG.map(
  (model) =>
    `- ${model.id} (${model.label}, ~${model.cost}/1M out): ${model.blurb}`
).join('\n');

const SYSTEM_PROMPT = `You are the model router for a Slack assistant that can write and run code in a sandbox, browse the web, analyze files/images, and use many tools. Pick the single best model for the assistant's NEXT turn from this catalog:

${CATALOG_BLURBS}

The user message may be a transcript of recent thread messages (one per line, "name: text"). Route based on the actual task the assistant must now perform, not just the last line — a short follow-up like "continue" or "go on" still inherits the underlying task (e.g. building a website ⇒ a coding model), so look at the whole conversation.

Guidance:
- Match the model to the work. Default to the cheapest model that can clearly do the job well.
- Use a fast model only for greetings, small talk, and quick standalone questions.
- Use a coding/agentic model for building, debugging, deploying, or multi-step tool work.
- Use a multimodal model when images, files, audio, or video must be understood.
- Reserve the most expensive frontier models for genuinely hard, high-stakes tasks.
- Never pick a model in the avoid list.

Reply with ONLY the exact model id, nothing else.`;

const ROUTING_HISTORY_LIMIT = 8;
const PER_MESSAGE_CHARS = 300;

/**
 * Build the router's input: a compact transcript of the recent thread so the
 * router can route follow-ups ("continue") by the underlying task, not just the
 * latest line. Falls back to the current message text if history is unavailable.
 */
export async function buildRoutingContext({
  threadId,
  fallbackText,
}: {
  threadId: string;
  fallbackText: string;
}): Promise<string> {
  try {
    const { messages } = await slack.fetchMessages(threadId, {
      limit: ROUTING_HISTORY_LIMIT,
    });
    if (!messages?.length) {
      return fallbackText;
    }
    const transcript = messages
      .map((message) => {
        const who = message.author.isMe
          ? 'kyto'
          : (message.author.userName ?? message.author.fullName ?? 'user');
        return `${who}: ${(message.text ?? '').slice(0, PER_MESSAGE_CHARS)}`;
      })
      .join('\n')
      .trim();
    return transcript || fallbackText;
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), threadId },
      '[router] history fetch failed, routing on current message only'
    );
    return fallbackText;
  }
}

/**
 * Ask the router model to choose the best catalog model for this request.
 * `exclude` lists model ids that already failed, so the router avoids them.
 * Always returns a valid catalog id that is not excluded; on any failure (or no
 * key) it falls back to the cheapest non-excluded model, never throwing.
 */
export async function pickModel({
  text,
  exclude = [],
}: {
  text: string;
  exclude?: string[];
}): Promise<string> {
  const available = CATALOG_IDS.filter((id) => !exclude.includes(id));
  const [first] = available;
  if (!first) {
    return DEFAULT_MODEL;
  }
  if (available.length === 1) {
    return first;
  }
  if (!env.HACKCLUB_API_KEY) {
    return fallbackChoice(exclude);
  }
  try {
    const userContent =
      exclude.length > 0
        ? `Avoid these models (they just failed): ${exclude.join(', ')}\n\nRequest:\n${text.slice(0, MAX_INPUT_CHARS)}`
        : text.slice(0, MAX_INPUT_CHARS);
    const response = await fetch(ROUTER_URL, {
      body: JSON.stringify({
        max_tokens: 24,
        messages: [
          { content: SYSTEM_PROMPT, role: 'system' },
          { content: userContent, role: 'user' },
        ],
        model: ROUTER_MODEL,
        temperature: 0,
      }),
      headers: {
        Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`router HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    const chosen = available.find((id) => raw.includes(id));
    if (chosen) {
      logger.info({ chosen, exclude }, '[router] model chosen');
      return chosen;
    }
    logger.warn(
      { exclude, raw },
      '[router] unparseable choice, using fallback'
    );
    return fallbackChoice(exclude);
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), exclude },
      '[router] failed, using fallback'
    );
    return fallbackChoice(exclude);
  }
}

// Deterministic fallback: the default model if free, else the cheapest catalog
// model not already excluded (CATALOG_IDS is ordered cheapest-first).
function fallbackChoice(exclude: string[]): string {
  if (!exclude.includes(DEFAULT_MODEL)) {
    return DEFAULT_MODEL;
  }
  return CATALOG_IDS.find((id) => !exclude.includes(id)) ?? DEFAULT_MODEL;
}
