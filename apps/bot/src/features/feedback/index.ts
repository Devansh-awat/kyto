import { recordReplyFeedback } from '@repo/db/queries';
import { z } from 'zod';
import { env } from '@/env';
import type { ActionEvent } from '@/harness';
import { mrkdwn, plainText } from '@/harness/views';
import { bot, slack } from '@/lib/chat';
import {
  FEEDBACK_DOWN_ACTION,
  FEEDBACK_UP_ACTION,
} from '@/lib/feedback/footer';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// 👍/👎 under a reply (the footer from lib/feedback/footer). The rating is saved
// the moment the button is clicked, so closing the comment box loses nothing;
// the modal only adds an optional comment to the same row. The owner is DM'd
// both times, because a rating sitting in a table nobody reads is not feedback.

const SUBMIT_CALLBACK = 'reply_feedback_submit';
const COMMENT_BLOCK = 'feedback_comment';
const MAX_COMMENT_CHARS = 2000;

// Round-tripped through Slack in private_metadata, so it is parsed, not trusted.
// Nothing in it grants anything: it only says which row a comment belongs to,
// and the row is keyed by the SUBMITTER's own id, never one from the payload.
const metadataSchema = z.object({
  channelId: z.string().min(1),
  messageTs: z.string().min(1),
  model: z.string().optional(),
  rating: z.enum(['up', 'down']),
  threadId: z.string().min(1),
});

type FeedbackMetadata = z.infer<typeof metadataSchema>;

async function permalinkFor({
  channelId,
  messageTs,
}: {
  channelId: string;
  messageTs: string;
}): Promise<string | undefined> {
  const result = await slack.webClient.chat
    .getPermalink({ channel: channelId, message_ts: messageTs })
    .catch(() => undefined);
  return result?.permalink;
}

async function tellOwner({
  comment,
  metadata,
  userId,
}: {
  comment?: string;
  metadata: FeedbackMetadata;
  userId: string;
}): Promise<void> {
  // The owner rating his own bot is not news to him.
  if (!env.OWNER_USER_ID || userId === env.OWNER_USER_ID) {
    return;
  }
  const link = await permalinkFor(metadata);
  const emoji = metadata.rating === 'up' ? '👍' : '👎';
  const where = link ? `<${link}|this reply>` : 'a reply';
  const model = metadata.model ? ` (\`${metadata.model}\`)` : '';
  const lines = [`${emoji} from <@${userId}> on ${where}${model}`];
  if (comment) {
    lines.push(`> ${comment.replaceAll('\n', '\n> ')}`);
  }
  try {
    const dm = await bot.openDM(env.OWNER_USER_ID);
    await dm.post({ markdown: lines.join('\n') });
  } catch (error) {
    logger.warn(
      { ...toLogError(error), userId },
      '[feedback] could not DM the owner'
    );
  }
}

async function onRating(
  event: ActionEvent,
  rating: 'up' | 'down'
): Promise<void> {
  const messageTs = event.messageId;
  if (!messageTs) {
    return;
  }
  const { channel: channelId } = slack.decodeThreadId(event.threadId);
  const metadata: FeedbackMetadata = {
    channelId,
    messageTs,
    model: event.value || undefined,
    rating,
    threadId: event.threadId,
  };
  const userId = event.user.userId;
  try {
    await recordReplyFeedback({ ...metadata, userId });
  } catch (error) {
    logger.warn(
      { ...toLogError(error), userId },
      '[feedback] could not save a rating'
    );
    return;
  }
  logger.info(
    { model: metadata.model, rating, threadId: event.threadId, userId },
    '[feedback] rated a reply'
  );
  await tellOwner({ metadata, userId });
  if (!event.triggerId) {
    return;
  }
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: {
        blocks: [
          {
            text: mrkdwn(
              rating === 'up'
                ? 'thanks! anything in particular that was good?'
                : 'thanks for saying so. what went wrong?'
            ),
            type: 'section',
          },
          {
            block_id: COMMENT_BLOCK,
            element: {
              action_id: 'comment',
              max_length: MAX_COMMENT_CHARS,
              multiline: true,
              type: 'plain_text_input',
            },
            label: plainText('Comment (optional)'),
            optional: true,
            type: 'input',
          },
        ],
        callback_id: SUBMIT_CALLBACK,
        close: plainText('Skip'),
        private_metadata: JSON.stringify(metadata),
        submit: plainText('Send'),
        title: plainText('Feedback'),
        type: 'modal',
      },
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId },
        '[feedback] could not open the comment box'
      );
    });
}

bot.onAction(FEEDBACK_UP_ACTION, (event) => onRating(event, 'up'));
bot.onAction(FEEDBACK_DOWN_ACTION, (event) => onRating(event, 'down'));

bot.onModalSubmit(SUBMIT_CALLBACK, async (event) => {
  const parsed = metadataSchema.safeParse(
    (() => {
      try {
        return JSON.parse(event.privateMetadata ?? '');
      } catch {
        return null;
      }
    })()
  );
  if (!parsed.success) {
    return { action: 'clear' };
  }
  const comment = event.values[COMMENT_BLOCK]?.trim();
  if (!comment) {
    return { action: 'clear' };
  }
  const userId = event.user.userId;
  try {
    await recordReplyFeedback({ ...parsed.data, comment, userId });
  } catch (error) {
    logger.warn(
      { ...toLogError(error), userId },
      '[feedback] could not save a comment'
    );
    return {
      action: 'errors',
      errors: { [COMMENT_BLOCK]: 'Could not save that. Try again.' },
    };
  }
  await tellOwner({ comment, metadata: parsed.data, userId });
  return { action: 'clear' };
});
