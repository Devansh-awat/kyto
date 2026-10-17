// Describe images as text: for a text-only model, and for `viewImage` with a
// specific question (a dedicated look at the pixels answers it better than the
// turn's model glancing at the image mid-task). Runs on haiku or luna like every
// non-turn call, Gemini behind them.

import { type ImageInput, streamAttempt } from './agent';
import { drawnAttempts, visionAttempt } from './providers/attempts';

// Cap how many images one turn describes, so a bulk upload can't fan out into a
// huge multi-image vision call. The rest are still on disk in the sandbox for a
// tool to read; only their inline description is bounded.
const MAX_DESCRIBED_IMAGES = 6;

const DESCRIBE_INSTRUCTION =
  'You are describing image(s) for a text-only AI assistant that cannot see them. ' +
  'For each image, transcribe ALL visible text verbatim (treat this as OCR), and ' +
  'describe layout/UI, code, diagrams, charts, tables, people, objects and colors — ' +
  'anything that could matter to answering a question about it. Be thorough and ' +
  'factual; do not speculate or add commentary. If there are multiple images, label ' +
  'them Image 1, Image 2, … in order.';

/**
 * Return a text description of the given images, or null if there is nothing to
 * describe or the vision call failed (callers fall back to sending the raw
 * images, or to no description — never to a broken turn).
 */
export async function describeImages({
  images,
  question,
  signal,
}: {
  images: ImageInput[];
  /**
   * A specific thing to look for ("what does the error message say?", "how many
   * cores are listed?"). Without it the vision model writes a general
   * description, which is a lot of tokens for a question that had one answer —
   * and a general description regularly missed the one detail that was asked
   * about. With it, the answer comes back first and the description second.
   */
  question?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const usable = images.slice(0, MAX_DESCRIBED_IMAGES);
  if (usable.length === 0) {
    return null;
  }
  // Haiku or luna at random like every non-turn call (owner's call
  // 2026-10-17); Gemini, then its dedicated vision model, behind them.
  const attempts = [
    ...drawnAttempts(),
    ...(visionAttempt ? [visionAttempt] : []),
  ].filter(
    (attempt, index, all) =>
      all.findIndex((other) => other.model === attempt.model) === index
  );
  for (const attempt of attempts) {
    try {
      const result = streamAttempt({
        abortSignal: signal,
        attempt,
        holder: {},
        images: usable,
        prompt: question
          ? `The assistant asked specifically: "${question}". Answer that FIRST, directly and completely, then give the description.`
          : 'Describe the image(s).',
        source: 'vision',
        system: DESCRIBE_INSTRUCTION,
        tools: {},
      });
      const text = (await result.text).trim();
      if (text) {
        return text;
      }
    } catch {
      // The next model.
    }
    if (signal?.aborted) {
      return null;
    }
  }
  return null;
}
