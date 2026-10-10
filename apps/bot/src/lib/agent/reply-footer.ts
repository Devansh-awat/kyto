import { type ModelAttempt, PRIMARY_ATTEMPT, UPGRADE_ATTEMPTS } from '@repo/ai';
import type { ThreadHandle } from '@/harness/thread';
import { attemptKey } from '@/lib/agent/routing';
import { hackclubOutage } from '@/lib/ai/hackclub-status';
import { buildReplyFooter } from '@/lib/feedback/footer';

// What the fallback note calls the usual model. Named in words rather than by
// slug because the note is for people, not for the journal.
const PRIMARY_LABEL = 'claude haiku 5.5 on hack club ai';

/**
 * The footer under a reply (lib/feedback/footer). Best-effort — a failure here
 * never affects the answer.
 *
 * The weaker-model note is for an answer that came from anywhere other than the
 * primary on kyto's own chain: not for a person's own key (their choice, their
 * model), not for the thread's `!with` model (also their choice), and not for
 * an upgrade (a step UP, which the Thinking card already says).
 */
export async function postReplyFooter({
  answeredBy,
  durationMs,
  isChosen,
  isOwnAttempt,
  showFooter,
  thread,
}: {
  answeredBy: ModelAttempt;
  durationMs: number;
  isChosen: boolean;
  isOwnAttempt: boolean;
  showFooter: boolean;
  thread: ThreadHandle;
}): Promise<void> {
  const key = attemptKey(answeredBy);
  const outage = await hackclubOutage();
  const steppedDown =
    !(isOwnAttempt || isChosen) &&
    key !== attemptKey(PRIMARY_ATTEMPT) &&
    !UPGRADE_ATTEMPTS.some((candidate) => attemptKey(candidate) === key);
  const footer = buildReplyFooter({
    durationMs,
    fallback: steppedDown
      ? { model: answeredBy.model, outage, primaryLabel: PRIMARY_LABEL }
      : undefined,
    model: answeredBy.model,
    showFooter,
  });
  if (!footer) {
    return;
  }
  await thread.post(footer).catch(() => undefined);
}
