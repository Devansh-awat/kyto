import { tool } from 'ai';
import { z } from 'zod';
import { slack } from '@/lib/chat';
import {
  allCodeChannels,
  disableCodeChannel,
  enableCodeChannel,
  getCodeChannel,
} from '@/lib/code-channels';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Turning a channel into a code channel makes kyto answer EVERY top-level
// message in it, so it is the channel's to decide: only its creator (or the
// bot owner) may turn one on. A channel kyto creates here is the requester's,
// and they are invited into it. Off: whoever turned it on, the channel's
// creator, or the owner.

const infoSchema = z.looseObject({
  channel: z
    .looseObject({
      creator: z.string().optional(),
      is_im: z.boolean().optional(),
      is_member: z.boolean().optional(),
      is_mpim: z.boolean().optional(),
      is_private: z.boolean().optional(),
    })
    .optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});

const createSchema = z.looseObject({
  channel: z.looseObject({ id: z.string() }).optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});

async function channelInfo(channel: string) {
  return infoSchema.parse(
    await slack.webClient.apiCall('conversations.info', { channel })
  );
}

export function codeChannelTool({
  authorUserId,
  currentChannel,
  isOwner,
}: {
  authorUserId: string;
  currentChannel: string;
  isOwner: boolean;
}) {
  return tool({
    description:
      "Manage CODE CHANNELS: channels where you answer every top-level message without being mentioned (each in its own thread), and every thread shares one sandbox workspace so work carries over. Only when someone explicitly asks. `create` makes a new channel, invites them and turns it on; `enable`/`disable` act on an existing channel (default: this one) — only the channel's creator or the bot owner may enable; `list` shows them all.",
    inputSchema: z.object({
      action: z.enum(['create', 'enable', 'disable', 'list']),
      channel: z
        .string()
        .regex(/^[CG][A-Z0-9]+$/)
        .optional()
        .describe('Channel id for enable/disable. Defaults to this channel.'),
      isPrivate: z.boolean().optional().describe('create: a private channel.'),
      name: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('create: channel name (lowercase, hyphens, no spaces).'),
    }),
    execute: async ({ action, channel, isPrivate, name }) => {
      try {
        if (action === 'list') {
          const rows = await allCodeChannels();
          return {
            channels: rows.map((row) => ({
              channel: `<#${row.channelId}>`,
              enabledBy: `<@${row.enabledBy}>`,
            })),
            success: true,
          };
        }

        if (action === 'create') {
          if (!name) {
            return { error: 'create needs a name.', success: false };
          }
          const created = createSchema.parse(
            await slack.webClient.apiCall('conversations.create', {
              is_private: isPrivate ?? false,
              name,
            })
          );
          if (!(created.ok && created.channel)) {
            return {
              error: `Could not create the channel: ${created.error ?? 'unknown error'}`,
              success: false,
            };
          }
          const id = created.channel.id;
          await slack.webClient
            .apiCall('conversations.invite', {
              channel: id,
              users: authorUserId,
            })
            .catch((error: unknown) => {
              logger.warn(
                { channel: id, error: errorMessage(error) },
                '[codeChannel] invite failed'
              );
            });
          await enableCodeChannel({ channelId: id, enabledBy: authorUserId });
          return {
            channel: `<#${id}>`,
            success: true,
            summary: `Created <#${id}> as a code channel.`,
          };
        }

        const target = channel ?? currentChannel;
        if (!/^[CG]/.test(target)) {
          return {
            error: 'Code channels are channels, not DMs.',
            success: false,
          };
        }
        const info = await channelInfo(target);
        if (!(info.ok && info.channel)) {
          return {
            error: `Could not read that channel: ${info.error ?? 'unknown error'}`,
            success: false,
          };
        }
        if (info.channel.is_im || info.channel.is_mpim) {
          return {
            error: 'Code channels are channels, not DMs.',
            success: false,
          };
        }
        const isCreator = info.channel.creator === authorUserId;

        if (action === 'disable') {
          const row = await getCodeChannel(target);
          if (!row) {
            return {
              error: `<#${target}> is not a code channel.`,
              success: false,
            };
          }
          if (!(isOwner || isCreator || row.enabledBy === authorUserId)) {
            return {
              error:
                'Only whoever turned it on, the channel creator or the bot owner can turn a code channel off.',
              success: false,
            };
          }
          await disableCodeChannel(target);
          return {
            success: true,
            summary: `<#${target}> is a normal channel again.`,
          };
        }

        if (!(isOwner || isCreator)) {
          return {
            error:
              "Only the channel's creator or the bot owner can make it a code channel — it would have me answer every message in it.",
            success: false,
          };
        }
        if (!info.channel.is_member) {
          if (info.channel.is_private) {
            return {
              error: 'Invite me to that private channel first.',
              success: false,
            };
          }
          await slack.webClient.apiCall('conversations.join', {
            channel: target,
          });
        }
        await enableCodeChannel({ channelId: target, enabledBy: authorUserId });
        return {
          success: true,
          summary: `<#${target}> is now a code channel.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[codeChannel] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
