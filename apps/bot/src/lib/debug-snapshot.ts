import { randomBytes } from 'node:crypto';
import {
  getThreadSummary,
  getThreadThinking,
  listThreadRevisions,
  listTurnTimings,
  pruneDebugSnapshots,
  readThreadLogs,
  saveDebugSnapshot,
} from '@repo/db/queries';
import { env } from '@/env';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { redactSecretsDeep } from '@/lib/redact';
import { describeTiming } from '@/lib/turn-timings';
import { errorMessage } from '@/lib/utils/error';

// `!debug` (owner only, owner's ask 2026-10-11): freeze what kyto knew and did
// in a thread — stage timings, captured log lines (tool calls, fallbacks,
// errors), its stored reasoning and digest, kept edits — into one immutable
// record on the password-protected dashboard. Thread logs last a week and the
// reasoning is rewritten every turn; a snapshot still says what it said.
const LOG_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LOG_CHARS = 400_000;
const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export async function createDebugSnapshot({
  createdBy,
  threadId,
}: {
  createdBy: string;
  threadId: string;
}): Promise<string> {
  const { channel, threadTs } = slack.decodeThreadId(threadId);
  const [timings, logs, thinking, summary, revisions] = await Promise.all([
    listTurnTimings({ limit: 20, threadId }),
    readThreadLogs({
      since: new Date(Date.now() - LOG_WINDOW_MS),
      threadId,
    }),
    getThreadThinking(threadId),
    getThreadSummary(threadId, MONTH_MS),
    listThreadRevisions({
      channel,
      since: new Date(Date.now() - MONTH_MS),
      ...(threadTs ? { rootTs: threadTs } : {}),
    }),
  ]);
  const logText = logs.map((batch) => batch.lines).join('\n');
  const body = redactSecretsDeep(
    {
      logs:
        logText.length > MAX_LOG_CHARS
          ? `… [${logText.length - MAX_LOG_CHARS} earlier chars cut]\n${logText.slice(-MAX_LOG_CHARS)}`
          : logText,
      revisions: revisions.map((row) => ({
        at: row.createdAt.toISOString(),
        kind: row.kind,
        messageTs: row.messageTs,
        text: row.text,
        userId: row.userId,
      })),
      summary: summary?.summary ?? null,
      thinking,
      timings: timings.map((row) => ({
        line: describeTiming(row),
        raw: row.timing,
      })),
    },
    'debug snapshot'
  );
  const id = randomBytes(16).toString('hex');
  await saveDebugSnapshot({ body, createdBy, id, threadId });
  return id;
}

export function debugSnapshotUrl(id: string): string {
  return `https://${env.SITES_PUBLIC_HOST}/_dashboard/debug/${id}`;
}

export function startDebugSnapshotReaper(): void {
  const prune = () =>
    pruneDebugSnapshots(new Date(Date.now() - SNAPSHOT_RETENTION_MS)).catch(
      (error: unknown) => {
        logger.warn({ err: errorMessage(error) }, '[debug] prune failed');
      }
    );
  prune();
  setInterval(prune, PRUNE_INTERVAL_MS).unref();
}
