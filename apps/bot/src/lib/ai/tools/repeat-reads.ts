// One turn re-read the same pasted thread three times and repeated half its
// searches, each a 1.5-4s Slack round trip with a ~100-message result (#56).
// The tools are built per turn (lib/ai/toolset), so a cache made by the
// factory lives exactly one turn. Short-lived even so: a long turn that reads a
// thread again to see new replies must get them.
const REPEAT_WINDOW_MS = 2 * 60 * 1000;

const REPEAT_NOTE =
  'Same read as earlier this turn, so this is that result again: nothing new. Use what you already have.';

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
  const recent = new Map<string, { at: number; result: Output }>();
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
      return { ...hit.result, repeat: REPEAT_NOTE };
    }
    const result = await run(input);
    recent.set(key, { at: Date.now(), result });
    return result;
  };
}
