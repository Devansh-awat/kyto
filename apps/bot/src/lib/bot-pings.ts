// Answering OTHER bots (owner's ask, 2026-09-29: "if a bot pings kyto then it
// also responds").
//
// A bot is answered when it @mentions kyto, or — in a thread kyto follows —
// when kyto itself @mentioned that bot there in the last hour (bot.ts), since a
// bot like Kevin answers without pinging back. Never in a DM, which has no
// mention to require. And only so many turns in a row: two bots answering each
// other would otherwise talk forever, on the shared budget, in a public thread.
// 50 is the owner's number (2026-10-02, "two bots can talk for 50 turns"); at
// the cap kyto says it stopped. A human speaking in the thread resets the count.

export const MAX_BOT_TURNS_IN_A_ROW = 50;
const WINDOW_MS = 15 * 60 * 1000;

interface Streak {
  count: number;
  lastAt: number;
}

const streaks = new Map<string, Streak>();

/**
 * Whether a bot's message in this thread may start a turn, counting it if so.
 * `stopped-now` is the first refusal of a streak — the moment to say so once;
 * every later one is plain `stopped`. `now` is injectable for tests.
 */
export function allowBotTurn(
  threadId: string,
  now = Date.now()
): 'allowed' | 'stopped-now' | 'stopped' {
  const streak = streaks.get(threadId);
  const current =
    streak && now - streak.lastAt < WINDOW_MS
      ? streak
      : { count: 0, lastAt: 0 };
  if (current.count > MAX_BOT_TURNS_IN_A_ROW) {
    return 'stopped';
  }
  // Counted past the cap once, so the announcement is made exactly once; the
  // window keeps sliding while bots keep talking, so it isn't repeated either.
  streaks.set(threadId, { count: current.count + 1, lastAt: now });
  return current.count === MAX_BOT_TURNS_IN_A_ROW ? 'stopped-now' : 'allowed';
}

/** A person spoke in the thread: bots may be answered again. */
export function noteHumanMessage(threadId: string): void {
  streaks.delete(threadId);
}
