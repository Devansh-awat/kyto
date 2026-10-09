import {
  deleteChannelInstructions,
  getChannelInstructions,
  setChannelInstructions,
} from '@repo/db/queries';
import { z } from 'zod';
import { env } from '@/env';
import { publishHome } from '@/features/customizations/service';
import { buildChannelInstructionsModal } from '@/features/customizations/views';
import type { ModalSubmitEvent, ModalSubmitResult } from '@/harness/types';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// A channel's standing instructions, set from App Home. Only the channel's
// creator or the owner may set, edit or remove them, checked when the modal
// opens AND when it is submitted — the channel id rides through the client.

const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;
const metadataSchema = z.object({ channelId: z.string().regex(CHANNEL_ID) });
const channelInfoSchema = z.object({
  channel: z.object({ creator: z.string().optional() }).optional(),
});

/** Fails closed: a channel kyto can't read (private, not a member) is no one's. */
async function mayManage({
  channelId,
  userId,
}: {
  channelId: string;
  userId: string;
}): Promise<boolean> {
  if (env.OWNER_USER_ID && userId === env.OWNER_USER_ID) {
    return true;
  }
  if (!CHANNEL_ID.test(channelId)) {
    return false;
  }
  const info = await slack.webClient.conversations
    .info({ channel: channelId })
    .catch(() => undefined);
  const parsed = channelInfoSchema.safeParse(info);
  return parsed.success && parsed.data.channel?.creator === userId;
}

function parseMetadata(text: string | undefined): string | undefined {
  if (!text) {
    return;
  }
  try {
    const parsed = metadataSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.channelId : undefined;
  } catch {
    return;
  }
}

function openModal({
  existing,
  triggerId,
  userId,
}: {
  existing?: Awaited<ReturnType<typeof getChannelInstructions>>;
  triggerId: string;
  userId: string;
}): Promise<void> {
  return slack.webClient.views
    .open({
      trigger_id: triggerId,
      view: buildChannelInstructionsModal({ existing }) as never,
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId },
        '[channel-instructions] could not open the modal'
      );
    });
}

bot.onAction('home_set_channel_instructions', async (event) => {
  if (!event.triggerId) {
    return;
  }
  await openModal({ triggerId: event.triggerId, userId: event.user.userId });
});

bot.onAction('home_edit_channel_instructions', async (event) => {
  const channelId = event.value;
  if (!(channelId && event.triggerId)) {
    return;
  }
  if (!(await mayManage({ channelId, userId: event.user.userId }))) {
    return;
  }
  const existing = await getChannelInstructions(channelId).catch(
    () => undefined
  );
  if (!existing) {
    return;
  }
  await openModal({
    existing,
    triggerId: event.triggerId,
    userId: event.user.userId,
  });
});

bot.onAction('home_remove_channel_instructions', async (event) => {
  const channelId = event.value;
  if (!channelId) {
    return;
  }
  if (!(await mayManage({ channelId, userId: event.user.userId }))) {
    return;
  }
  await deleteChannelInstructions(channelId).catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), channelId },
      '[channel-instructions] could not remove'
    );
  });
  logger.info(
    { channelId, userId: event.user.userId },
    '[channel-instructions] removed'
  );
  await publishHome({ userId: event.user.userId }).catch(() => undefined);
});

bot.onModalSubmit(
  'home_channel_instructions_save',
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    const editing = parseMetadata(event.privateMetadata);
    const channelId = editing ?? event.values.instructions_channel;
    const errorBlock = editing ? 'instructions_prompt' : 'instructions_channel';
    if (!(channelId && CHANNEL_ID.test(channelId))) {
      return {
        action: 'errors',
        errors: { [errorBlock]: 'Pick a channel (not a DM).' },
      };
    }
    if (!(await mayManage({ channelId, userId: event.user.userId }))) {
      return {
        action: 'errors',
        errors: {
          [errorBlock]:
            "Only the channel's creator can set its instructions (and kyto has to be able to see the channel).",
        },
      };
    }
    const prompt = event.values.instructions_prompt?.trim() ?? '';
    if (prompt) {
      await setChannelInstructions({
        channelId,
        prompt,
        setBy: event.user.userId,
      });
    } else {
      await deleteChannelInstructions(channelId);
    }
    logger.info(
      {
        channelId,
        chars: prompt.length,
        removed: !prompt,
        userId: event.user.userId,
      },
      '[channel-instructions] saved'
    );
    await publishHome({ userId: event.user.userId }).catch(() => undefined);
    return;
  }
);
