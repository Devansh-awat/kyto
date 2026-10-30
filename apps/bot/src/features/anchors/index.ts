import { anchorCard, canAnchor, getAnchor, removeAnchor } from '@/lib/anchors';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { DEFAULT_NPS_QUESTION } from '@/lib/slack/nps';
import { postNpsSurvey } from '@/lib/slack/nps-card';
import {
  buildPollBlocks,
  buildPollMetadata,
  postSlackMessage,
} from '@/lib/slack/poll';
import { errorMessage } from '@/lib/utils/error';

// `/kyto nps`, `/kyto poll` and `/kyto anchor`. Each posts a TOP-LEVEL card in
// the channel the command was typed in, so all of them take the anchor gate
// (Channel Managers + owner): a non-owner never has kyto start a top-level
// post. Anyone else can still ask kyto for a poll or survey in a thread.

const USAGE = [
  '`/kyto nps [--anchor] [days] [question]`: an NPS survey (0-10), open 7 days by default',
  '`/kyto poll [--anchor] question | option | option …`: a poll with 2-10 options',
  '`/kyto anchor status`: what is anchored here',
  '`/kyto anchor off`: stop keeping it at the bottom (the card stays, unpinned)',
].join('\n');
const MAX_DAYS = 90;
const MAX_POLL_OPTIONS = 10;

function tell({
  channelId,
  text,
  userId,
}: {
  channelId: string;
  text: string;
  userId: string;
}): void {
  slack.webClient.chat
    .postEphemeral({ channel: channelId, text, user: userId })
    .catch((error: unknown) => {
      logger.warn(
        { channelId, error: errorMessage(error), userId },
        '[anchors] could not answer a slash command'
      );
    });
}

async function run({
  action,
  args,
  channelId,
  userId,
}: {
  action: 'anchor' | 'nps' | 'poll';
  args: string[];
  channelId: string;
  userId: string;
}): Promise<string> {
  if (!(await canAnchor({ channelId, userId }))) {
    return "only this channel's Slack Channel Managers can do that here. anyone can still ask me for a poll or survey in a thread.";
  }

  if (action === 'anchor') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'off') {
      const removed = await removeAnchor(channelId);
      return removed
        ? `stopped anchoring the ${removed.kind === 'nps' ? 'survey' : 'poll'}. the card stays where it is.`
        : 'nothing is anchored here.';
    }
    if (sub === 'status') {
      const anchor = await getAnchor(channelId);
      return anchor
        ? `anchored here: a ${anchor.kind === 'nps' ? `survey (#${anchor.surveyId})` : 'poll'}, by <@${anchor.createdBy}>.`
        : 'nothing is anchored here.';
    }
    return USAGE;
  }

  const anchor = args.includes('--anchor');
  const rest = args.filter((word) => word !== '--anchor');

  if (action === 'nps') {
    let days = 7;
    if (rest[0] && /^\d+$/.test(rest[0])) {
      days = Number(rest.shift());
    }
    if (days < 1 || days > MAX_DAYS) {
      return `days must be 1-${MAX_DAYS}.\n${USAGE}`;
    }
    const question =
      rest.join(' ').trim().slice(0, 140) || DEFAULT_NPS_QUESTION;
    const { messageTs, surveyId } = await postNpsSurvey({
      channelId,
      createdBy: userId,
      days,
      question,
    });
    if (anchor) {
      await anchorCard({
        channelId,
        createdBy: userId,
        kind: 'nps',
        messageTs,
        surveyId,
      });
    }
    return `posted survey #${surveyId}, open ${days} day${days === 1 ? '' : 's'}${anchor ? ' and anchored' : ''}. ask me for its results any time.`;
  }

  const parts = rest
    .join(' ')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  const [question, ...options] = parts;
  if (!question || options.length < 2 || options.length > MAX_POLL_OPTIONS) {
    return `a poll needs a question and 2-${MAX_POLL_OPTIONS} options.\n${USAGE}`;
  }
  const state = {
    options: options.map((option) => option.slice(0, 150)),
    question: question.slice(0, 300),
    votes: {},
  };
  const messageTs = await postSlackMessage({
    blocks: buildPollBlocks(state),
    channel: channelId,
    metadata: buildPollMetadata(state),
    text: `Poll: ${state.question}`,
  });
  if (anchor) {
    await anchorCard({
      channelId,
      createdBy: userId,
      kind: 'poll',
      messageTs,
      surveyId: null,
    });
  }
  return `posted the poll${anchor ? ' and anchored it' : ''}.`;
}

/**
 * The slash ACK has 3 seconds and the manager check plus a post can take
 * longer, so this acks at once and answers with an ephemeral when done.
 */
export function runAnchorCommand({
  action,
  args,
  channelId,
  userId,
}: {
  action: 'anchor' | 'nps' | 'poll';
  args: string[];
  channelId: string;
  userId: string;
}): string | null {
  if (action === 'poll' && args.length === 0) {
    return USAGE;
  }
  run({ action, args, channelId, userId })
    .then((text) => tell({ channelId, text, userId }))
    .catch((error: unknown) => {
      logger.warn(
        { action, channelId, error: errorMessage(error), userId },
        '[anchors] slash command failed'
      );
      tell({
        channelId,
        text: `that didn't work: ${errorMessage(error)}. if i'm not in this channel, add me first.`,
        userId,
      });
    });
  return null;
}
