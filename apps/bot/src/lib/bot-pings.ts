// Answering OTHER bots (owner's ask, 2026-09-29: "if a bot pings kyto then it
// also responds").
//
// A bot is answered only when it @mentions kyto — never on the strength of kyto
// having joined a thread, and never in a DM, which have no mention to require.
// And even then only a few times in a row: two bots that each answer a mention
// with a mention would otherwise talk to each other forever, on the shared
// budget, in a public thread. A human speaking in the thread resets the count.

const MAX_BOT_TURNS_IN_A_ROW = 3;
const WINDOW_MS = 15 * 60 * 1000;

interface Streak {
  count: number;
  lastAt: number;
}

const streaks = new Map<string, Streak>();

/**
 * Whether a bot's mention in this thread may start a turn, counting it if so.
 * `now` is injectable for tests.
 */
export function allowBotTurn(threadId: string, now = Date.now()): boolean {
  const streak = streaks.get(threadId);
  const current =
    streak && now - streak.lastAt < WINDOW_MS
      ? streak
      : { count: 0, lastAt: 0 };
  if (current.count >= MAX_BOT_TURNS_IN_A_ROW) {
    return false;
  }
  streaks.set(threadId, { count: current.count + 1, lastAt: now });
  return true;
}

/** A person spoke in the thread: bots may be answered again. */
export function noteHumanMessage(threadId: string): void {
  streaks.delete(threadId);
}
