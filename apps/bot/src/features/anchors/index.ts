import { z } from 'zod';
import type { ModalSubmitResult } from '@/harness/types';
import { plainText } from '@/harness/views';
import { anchorCard, canAnchor, getAnchor, removeAnchor } from '@/lib/anchors';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { DEFAULT_NPS_QUESTION } from '@/lib/slack/nps';
import { postNpsSurvey } from '@/lib/slack/nps-card';
import {
  askerName,
  buildPollBlocks,
  buildPollMetadata,
  postSlackMessage,
} from '@/lib/slack/poll';
import { errorMessage } from '@/lib/utils/error';

// `/kyto nps` and `/kyto poll` open a form; submitting it posts the card at
// the top of the channel the command was typed in. Anyone may post one (owner's
// call 2026-10-30) and every card names who asked for it; only ANCHORING it is
// gated, to the owner and the channel's Slack Channel Managers.
// `/kyto anchor status|off` manages the channel's anchor.

const NPS_CALLBACK = 'kyto_nps_create';
const POLL_CALLBACK = 'kyto_poll_create';
const QUESTION_BLOCK = 'question';
const OPTIONS_BLOCK = 'options';
const DAYS_BLOCK = 'days';
const ANCHOR_BLOCK = 'anchor';
const MAX_DAYS = 90;
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 10;
const ANCHOR_USAGE =
  '`/kyto anchor status`: what is anchored here\n`/kyto anchor off`: stop keeping it at the bottom (the card stays, unpinned)';

// Set by us when the form opens and returned by Slack; parsed all the same.
const metadataSchema = z.object({ channelId: z.string().min(1) });

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
        '[anchors] could not answer'
      );
    });
}

const anchorBlock = {
  block_id: ANCHOR_BLOCK,
  element: {
    action_id: 'anchor',
    options: [
      {
        description: plainText(
          "Pin it and keep it at the bottom of the channel. The owner and this channel's Channel Managers only."
        ),
        text: plainText('Anchor it'),
        value: 'anchor',
      },
    ],
    type: 'checkboxes',
  },
  label: plainText('Anchor'),
  optional: true,
  type: 'input',
};

function questionBlock(initial: string) {
  return {
    block_id: QUESTION_BLOCK,
    element: {
      action_id: 'question',
      max_length: 140,
      type: 'plain_text_input',
      ...(initial && { initial_value: initial }),
    },
    label: plainText('Question'),
    type: 'input',
  };
}

function openForm({
  action,
  channelId,
  prefill,
  triggerId,
}: {
  action: 'nps' | 'poll';
  channelId: string;
  prefill: string;
  triggerId: string;
}): Promise<unknown> {
  const blocks =
    action === 'nps'
      ? [
          questionBlock(prefill.slice(0, 140) || DEFAULT_NPS_QUESTION),
          {
            block_id: DAYS_BLOCK,
            element: {
              action_id: 'days',
              initial_value: '7',
              is_decimal_allowed: false,
              max_value: String(MAX_DAYS),
              min_value: '1',
              type: 'number_input',
            },
            hint: plainText(
              'People can answer until then; then it shows the NPS.'
            ),
            label: plainText('Open for (days)'),
            type: 'input',
          },
          anchorBlock,
        ]
      : [
          questionBlock(prefill.slice(0, 140)),
          {
            block_id: OPTIONS_BLOCK,
            element: {
              action_id: 'options',
              multiline: true,
              type: 'plain_text_input',
            },
            hint: plainText(
              `One per line, ${MIN_POLL_OPTIONS}-${MAX_POLL_OPTIONS} options.`
            ),
            label: plainText('Options'),
            type: 'input',
          },
          anchorBlock,
        ];
  return slack.webClient.apiCall('views.open', {
    trigger_id: triggerId,
    view: {
      blocks,
      callback_id: action === 'nps' ? NPS_CALLBACK : POLL_CALLBACK,
      close: plainText('Cancel'),
      private_metadata: JSON.stringify({ channelId }),
      submit: plainText('Post'),
      title: plainText(action === 'nps' ? 'NPS survey' : 'Poll'),
      type: 'modal',
    },
  });
}

async function runAnchor({
  args,
  channelId,
  userId,
}: {
  args: string[];
  channelId: string;
  userId: string;
}): Promise<string> {
  const sub = args[0]?.toLowerCase();
  if (sub === 'status') {
    const anchor = await getAnchor(channelId);
    return anchor
      ? `anchored here: a ${anchor.kind === 'nps' ? `survey (#${anchor.surveyId})` : 'poll'}, by <@${anchor.createdBy}>.`
      : 'nothing is anchored here.';
  }
  if (sub !== 'off') {
    return ANCHOR_USAGE;
  }
  if (!(await canAnchor({ channelId, userId }))) {
    return "only the owner or this channel's Channel Managers can change its anchor.";
  }
  const removed = await removeAnchor(channelId);
  return removed
    ? `stopped anchoring the ${removed.kind === 'nps' ? 'survey' : 'poll'}. the card stays where it is.`
    : 'nothing is anchored here.';
}

/** Acks at once; the form or the answer follows (Slack gives 3 seconds). */
export function runAnchorCommand({
  action,
  args,
  channelId,
  triggerId,
  userId,
}: {
  action: 'anchor' | 'nps' | 'poll';
  args: string[];
  channelId: string;
  triggerId?: string;
  userId: string;
}): string | null {
  if (action === 'anchor') {
    runAnchor({ args, channelId, userId })
      .then((text) => tell({ channelId, text, userId }))
      .catch((error: unknown) => {
        tell({
          channelId,
          text: `that didn't work: ${errorMessage(error)}`,
          userId,
        });
      });
    return null;
  }
  if (!triggerId) {
    return "couldn't open the form, try again.";
  }
  openForm({ action, channelId, prefill: args.join(' '), triggerId }).catch(
    (error: unknown) => {
      logger.warn(
        { action, channelId, error: errorMessage(error), userId },
        '[anchors] could not open the form'
      );
      tell({ channelId, text: "couldn't open the form, try again.", userId });
    }
  );
  return null;
}

function parseMetadata(raw: string | undefined) {
  try {
    return metadataSchema.safeParse(JSON.parse(raw ?? '')).data;
  } catch {
    return;
  }
}

/** Post (and maybe anchor) after the form has closed; failures are told. */
function postInBackground({
  channelId,
  post,
  userId,
}: {
  channelId: string;
  post: () => Promise<void>;
  userId: string;
}): void {
  post().catch((error: unknown) => {
    logger.warn(
      { channelId, error: errorMessage(error), userId },
      '[anchors] could not post from the form'
    );
    tell({
      channelId,
      text: `couldn't post it: ${errorMessage(error)}. if i'm not in this channel, add me first.`,
      userId,
    });
  });
}

bot.onModalSubmit(NPS_CALLBACK, async (event): Promise<ModalSubmitResult> => {
  const metadata = parseMetadata(event.privateMetadata);
  if (!metadata) {
    return { action: 'clear' };
  }
  const { channelId } = metadata;
  const userId = event.user.userId;
  const question = event.values[QUESTION_BLOCK]?.trim().slice(0, 140);
  const days = Number(event.values[DAYS_BLOCK]);
  if (!question) {
    return { action: 'errors', errors: { [QUESTION_BLOCK]: 'Ask something.' } };
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return {
      action: 'errors',
      errors: { [DAYS_BLOCK]: `1 to ${MAX_DAYS} days.` },
    };
  }
  const anchor = event.multiValues?.[ANCHOR_BLOCK]?.includes('anchor') ?? false;
  if (anchor && !(await canAnchor({ channelId, userId }))) {
    return {
      action: 'errors',
      errors: {
        [ANCHOR_BLOCK]:
          "Only the owner or this channel's Channel Managers can anchor. Uncheck it to post it normally.",
      },
    };
  }
  postInBackground({
    channelId,
    post: async () => {
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
    },
    userId,
  });
  return { action: 'clear' };
});

bot.onModalSubmit(POLL_CALLBACK, async (event): Promise<ModalSubmitResult> => {
  const metadata = parseMetadata(event.privateMetadata);
  if (!metadata) {
    return { action: 'clear' };
  }
  const { channelId } = metadata;
  const userId = event.user.userId;
  const question = event.values[QUESTION_BLOCK]?.trim().slice(0, 300);
  const options = (event.values[OPTIONS_BLOCK] ?? '')
    .split('\n')
    .map((line) => line.trim().slice(0, 150))
    .filter(Boolean);
  if (!question) {
    return { action: 'errors', errors: { [QUESTION_BLOCK]: 'Ask something.' } };
  }
  if (options.length < MIN_POLL_OPTIONS || options.length > MAX_POLL_OPTIONS) {
    return {
      action: 'errors',
      errors: {
        [OPTIONS_BLOCK]: `${MIN_POLL_OPTIONS}-${MAX_POLL_OPTIONS} options, one per line (you gave ${options.length}).`,
      },
    };
  }
  const anchor = event.multiValues?.[ANCHOR_BLOCK]?.includes('anchor') ?? false;
  if (anchor && !(await canAnchor({ channelId, userId }))) {
    return {
      action: 'errors',
      errors: {
        [ANCHOR_BLOCK]:
          "Only the owner or this channel's Channel Managers can anchor. Uncheck it to post it normally.",
      },
    };
  }
  postInBackground({
    channelId,
    post: async () => {
      const state = {
        askedBy: await askerName(userId),
        options,
        question,
        votes: {},
      };
      const messageTs = await postSlackMessage({
        blocks: buildPollBlocks(state),
        channel: channelId,
        metadata: buildPollMetadata(state),
        text: `Poll: ${question}`,
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
    },
    userId,
  });
  return { action: 'clear' };
});
