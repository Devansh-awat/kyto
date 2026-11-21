import {
  LUNA_MODEL,
  type ModelAttempt,
  PRIMARY_ATTEMPT,
  UPGRADE_ATTEMPTS,
} from '@repo/ai';
import { attemptKey } from '@/lib/agent/routing';
import { hackclubOutage } from '@/lib/ai/hackclub-status';
import { buildReplyFooter } from '@/lib/feedback/footer';
import { errorMessage, errorStatus } from '@/lib/utils/error';

// What the fallback note calls the usual model. Named in words rather than by
// slug because the note is for people, not for the journal.
const PRIMARY_LABEL = 'claude haiku 5.5 on hack club ai';

/**
 * The footer under a reply (lib/feedback/footer): the blocks the turn's last
 * streamed message ends with, or null when there is nothing to show.
 *
 * The weaker-model note is for an answer that came from anywhere other than the
 * primary on kyto's own chain: not for a person's own key (their choice, their
 * model), not for the thread's `--model` (also their choice), not for
 * an upgrade (a step UP, which the Thinking card already says), and not for
 * luna: it leads half of all threads in the haiku/luna experiment, so a turn
 * it picked up is no worse than those (owner's call 2026-11-21).
 *
 * The note's reason is a real Hack Club AI outage when there is one, else what
 * the lead attempt actually did: blaming Hack Club for a haiku that sent back
 * an empty reply sent people to a status page that had nothing to do with it.
 */
export async function replyFooter({
  answeredBy,
  durationMs,
  isChosen,
  isOwnAttempt,
  leadAttempt,
  leadError,
  showFooter,
}: {
  answeredBy: ModelAttempt;
  durationMs: number;
  isChosen: boolean;
  isOwnAttempt: boolean;
  /**
   * The model that was SUPPOSED to lead this turn when it wasn't the default
   * primary: the thread's `--model` pick or the experiment's drawn arm. When
   * that model fails and a lower rung answers, the note must name IT, not the
   * hardcoded Haiku label — a `--model mercury` turn that fell to Haiku used to
   * read "claude haiku 5.5 couldn't answer, so haiku did" (#130).
   */
  leadAttempt?: ModelAttempt;
  /** Why the first attempt of the turn failed, for the note's reason. */
  leadError?: unknown;
  showFooter: boolean;
}): Promise<ReturnType<typeof buildReplyFooter>> {
  const key = attemptKey(answeredBy);
  const steppedDown =
    !(isOwnAttempt || isChosen) &&
    key !== attemptKey(PRIMARY_ATTEMPT) &&
    answeredBy.model !== LUNA_MODEL &&
    !UPGRADE_ATTEMPTS.some((candidate) => attemptKey(candidate) === key);
  if (!steppedDown) {
    return buildReplyFooter({
      durationMs,
      model: answeredBy.model,
      showFooter,
    });
  }
  const status = errorStatus(leadError);
  let failure: string | undefined;
  if (status !== undefined) {
    failure = `it answered ${status}`;
  } else if (leadError !== undefined) {
    const message = errorMessage(leadError);
    if (message.includes('empty response')) {
      failure = 'it sent back an empty reply';
    } else if (message.includes('ended without a reply')) {
      failure = 'it stopped without a reply';
    } else {
      failure = 'it errored';
    }
  }
  const reason = (await hackclubOutage()) ?? failure;
  // The label of whatever led: a picked/drawn model answers under its own slug,
  // the default chain under the friendly primary name.
  const primaryLabel =
    leadAttempt && attemptKey(leadAttempt) !== attemptKey(PRIMARY_ATTEMPT)
      ? `\`${leadAttempt.model}\``
      : PRIMARY_LABEL;
  return buildReplyFooter({
    durationMs,
    fallback: {
      model: answeredBy.model,
      primaryLabel,
      ...(reason ? { reason } : {}),
    },
    model: answeredBy.model,
    showFooter,
  });
}
