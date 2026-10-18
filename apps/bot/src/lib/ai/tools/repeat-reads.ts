// One turn re-read the same pasted thread three times and repeated half its
// searches, each a 1.5-4s Slack round trip with a ~100-message result (#56).
// The tools are built per turn (lib/ai/toolset), so a cache made by the
// factory lives exactly one turn. Short-lived even so: a long turn that reads a
// thread again to see new replies must get them.
const REPEAT_WINDOW_MS = 2 * 60 * 1000;

const REPEAT_NOTE =
  'Same read as earlier this turn, so this is that result again: nothing new. Use what you already have.';
// A luna turn ran one search 19 times, 12 of them repeats, each repeat a whole
// model step on a 100k+ prompt (2026-10-18): the plain note didn't stop it.
const firmRepeatNote = (calls: number) =>
  `You have now made this exact call ${calls} times this turn and it returns the same result every time. Stop repeating it: change the query, or answer with what you have.`;

/**
 * Wraps a read tool's `execute` so an identical call within two minutes
 * returns the earlier result, marked as a repeat. A read that threw is not
 * kept, so it is retried for real.
 */
export function rememberRepeatReads<
  Input extends Record<string, unknown>,
  Output extends object,
>(
  run: (input: Input) => Promise<Output>
): (input: Input) => Promise<Output & { repeat?: string }> {
  const recent = new Map<
    string,
    { at: number; calls: number; result: Output }
  >();
  return async (input) => {
    // Sorted, and an unused field dropped: gpt-6-luna sends every optional
    // field, an unused one as "", and not always in the same order.
    const key = JSON.stringify(
      Object.entries(input)
        .filter(([, value]) => value !== '' && value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < REPEAT_WINDOW_MS) {
      hit.calls += 1;
      return {
        ...hit.result,
        repeat: hit.calls > 2 ? firmRepeatNote(hit.calls) : REPEAT_NOTE,
      };
    }
    const result = await run(input);
    // The count outlives the window: that turn's 19 calls spanned 11 minutes.
    recent.set(key, { at: Date.now(), calls: (hit?.calls ?? 0) + 1, result });
    return result;
  };
}
