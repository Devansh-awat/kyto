import {
  getThreadThinking,
  pruneThreadThinking,
  type StoredThinkingTurn,
  saveThreadThinking,
} from '@repo/db/queries';
import {
  THINKING_BUDGET_CHARS as DEFAULT_THINKING_BUDGET_CHARS,
  MAX_TURN_CHARS,
  type RecalledTurn,
  renderThinking as renderThinkingBlock,
  TOOL_RESULT_TURNS,
  tail,
} from '@/lib/agent/thinking-render';
import logger from '@/lib/logger';

// Kyto's memory of a conversation is the Slack thread itself (buildPrompt
// replays it). But Slack only records what was SAID — the reasoning that led to
// it is rendered into the plan's "Thinking" cards and then gone. So every turn
// used to start cold: kyto could see that it had said "let me check all 50
// slider positions" but not why, what it had already ruled out, or what it was
// part-way through. It re-derived the same dead ends.
//
// This keeps the FULL reasoning (and tool observations) of a thread's turns and
// buildPrompt feeds it back on the next turn — the whole history, oldest dropped
// only when the block would exceed a char budget (see THINKING_BUDGET_CHARS).
// PERSISTED to Postgres (thread_thinking) so it survives a restart — the old
// in-memory buffer was wiped on every deploy, which is why a thread picked back
// up after a restart lost its train of thought. Rows are reaped after
// RETENTION_MS so this stays a recent train of thought, not a permanent
// transcript.

// The model carries its reasoning across turns, the way it carries reasoning
// across tool calls WITHIN a turn: the end of a turn is just another boundary.
// How much of each past turn survives — and the whole block's ceiling — is
// decided by thinking-render.ts, which is pure and has tests.
const THINKING_BUDGET_CHARS = numericEnv(
  'THINKING_BUDGET_CHARS',
  DEFAULT_THINKING_BUDGET_CHARS
);
// Hard cap on how many turns are kept on disk, so a very long-lived thread's row
// stays bounded regardless of the char budget. Rendering trims further to fit.
const MAX_STORED_TURNS = 40;
// Past that, a turn keeps only its one-line-per-call actions, for the thread
// digest: compaction folds the OLDEST messages, long after their reasoning
// was dropped.
const MAX_ACTION_TURNS = 200;

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
// How long a thread's stored reasoning stays usable and on disk (~a month).
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Record one completed turn's reasoning AND what its tools observed. Called with
 * the reasoning blocks and tool observations of the attempt that actually
 * ANSWERED — a failed attempt's thinking is discarded with the attempt, so a
 * model that spiralled doesn't poison the next turn.
 *
 * Slack replays only what kyto SAID, never what it thought or what a tool
 * returned — so a fact kyto worked out but never typed (a captcha it decoded, an
 * OCR result, a computed value) is otherwise lost the moment the turn ends. Both
 * halves ride back into the next turn via buildPrompt.
 *
 * Best-effort: a DB hiccup here must never fail the turn.
 */
export async function rememberThinking({
  actions,
  blocks,
  messageTs,
  observations,
  privateTo,
  threadId,
}: {
  /** One line per tool call this turn, for thread compaction (#2). */
  actions?: string;
  blocks: string[];
  /** The Slack message this turn answered. */
  messageTs?: string;
  /** Pre-rendered, already-capped record of the turn's tool calls and results. */
  observations?: string;
  /** The speaker, when the turn read their private data (see recallThinking). */
  privateTo?: string;
  threadId: string;
}): Promise<void> {
  const reasoning = blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
  const tools = observations?.trim();
  if (!(reasoning || tools || actions)) {
    return;
  }
  try {
    const existing = await getThreadThinking(threadId, RETENTION_MS);
    // A turn past the last few is never shown its tool results again, so
    // they are not kept on disk either.
    const aged = existing.map((turn, index) =>
      typeof turn === 'object' &&
      turn.tools &&
      existing.length - index >= TOOL_RESULT_TURNS
        ? { ...turn, tools: undefined }
        : turn
    );
    const all = [
      ...aged,
      {
        ...(actions ? { actions } : {}),
        ...(messageTs ? { messageTs } : {}),
        ...(privateTo ? { privateTo } : {}),
        text: tail(reasoning, MAX_TURN_CHARS),
        ...(tools ? { tools } : {}),
      },
    ].slice(-MAX_ACTION_TURNS);
    const turns = all
      .map((turn, index): StoredThinkingTurn => {
        if (all.length - index <= MAX_STORED_TURNS) {
          return turn;
        }
        return typeof turn === 'object' && turn.actions
          ? {
              actions: turn.actions,
              ...(turn.messageTs ? { messageTs: turn.messageTs } : {}),
              ...(turn.privateTo ? { privateTo: turn.privateTo } : {}),
              text: '',
            }
          : '';
      })
      .filter((turn) => turn !== '');
    await saveThreadThinking(threadId, turns);
  } catch (error) {
    logger.warn({ err: error, threadId }, '[thinking] failed to persist');
  }
}

/**
 * The stored reasoning of this thread's turns, oldest first (render trims to
 * the char budget), as `speakerId` may see it. A turn that read someone's
 * private data — their DMs, a private channel, their email or MCP servers —
 * is shown in full only on that person's own turns: in a shared thread the
 * next speaker would otherwise get the raw text of someone else's DMs.
 */
export async function recallThinking({
  speakerId,
  threadId,
}: {
  speakerId: string;
  threadId: string;
}): Promise<RecalledTurn[]> {
  const turns: StoredThinkingTurn[] = await getThreadThinking(
    threadId,
    RETENTION_MS
  ).catch(() => []);
  // Actions-only entries are for the digest, not the replay.
  const replayed = turns.filter(
    (turn) => typeof turn === 'string' || turn.text || turn.tools
  );
  return replayed.map((turn) => {
    if (typeof turn === 'string') {
      return { reasoning: turn };
    }
    if (!turn.privateTo || turn.privateTo === speakerId) {
      return { reasoning: turn.text, tools: turn.tools };
    }
    return {
      reasoning: `[An earlier turn here, for <@${turn.privateTo}>, read their private data (DMs, a private channel, email or their own connected tools). Its reasoning and tool results are kept to their own turns, so they are not shown to you now. If you need what it found, ask them, or look it up yourself with the current speaker's access.]`,
    };
  });
}

// Reap reasoning older than the retention window, on startup and daily after.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function pruneThinking(): Promise<void> {
  await pruneThreadThinking(new Date(Date.now() - RETENTION_MS)).catch(
    (error: unknown) => {
      logger.warn({ err: error }, '[thinking] prune failed');
    }
  );
}

export function startThinkingReaper(): void {
  const tick = (): void => {
    pruneThinking().catch(() => undefined);
  };
  setInterval(tick, PRUNE_INTERVAL_MS);
  tick();
}

/**
 * The block buildPrompt injects. The decay rules and the framing live in
 * thinking-render.ts (pure, tested); this only supplies the env-overridable
 * budget.
 */
export function renderThinking(turns: RecalledTurn[]): string {
  return renderThinkingBlock(turns, THINKING_BUDGET_CHARS);
}

/**
 * What kyto did answering each message, by the message's ts, for the thread
 * digest. The digest is shared with everyone in the thread, so a turn that
 * read someone's private data says only that it did.
 */
export async function recallActions(
  threadId: string
): Promise<Map<string, string>> {
  const turns = await getThreadThinking(threadId, RETENTION_MS).catch(
    () => [] as StoredThinkingTurn[]
  );
  const actions = new Map<string, string>();
  for (const turn of turns) {
    if (typeof turn === 'string' || !(turn.actions && turn.messageTs)) {
      continue;
    }
    actions.set(
      turn.messageTs,
      turn.privateTo
        ? `(work done with <@${turn.privateTo}>'s private access; details kept to them)`
        : turn.actions
    );
  }
  return actions;
}
