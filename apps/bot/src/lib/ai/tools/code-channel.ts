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
//
// `create` makes a REAL Slack Code channel (Slack's `agent_channel` type:
// spaces in the name, the "Code Channel" label), not a plain channel — a plain
// one is what people called fake. Bots can't: `agents.conversations.create` is
// partner-only (`feature_disabled`). So, as coolton does, kyto's USER account
// calls the web client's own `client.codeChannels.create`, which needs one of
// the workspace's supported partner apps as the channel's agent. Datadog is
// that agent in name only — it isn't asked to do anything (no first message
// is sent), and kyto answers there as it does in any code channel.

// Datadog, one of `codeChannels.listSupportedApps`; coolton used it too.
const CODE_CHANNEL_AGENT_APP_ID = 'AR28NTK5M';
// The create modal opened from the code-channel browser.
const CODE_CHANNEL_ENTRYPOINT = 'fe_session_channel_browser';

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
      "Manage CODE CHANNELS: channels where you answer every top-level message without being mentioned (each in its own thread), and every thread shares one sandbox workspace so work carries over. Only when someone explicitly asks. `create` makes a new Slack Code channel (the real code-channel type, spaces allowed in the name), invites them and turns it on; `enable`/`disable` act on an existing channel (default: this one) — only the channel's creator or the bot owner may enable; `list` shows them all.",
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
        .describe(
          'create: channel name, as the person wrote it (spaces fine).'
        ),
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
          const account = slack.requireUserAccountClient();
          const created = createSchema.parse(
            await account.apiCall('client.codeChannels.create', {
              app_id: CODE_CHANNEL_AGENT_APP_ID,
              entrypoint: CODE_CHANNEL_ENTRYPOINT,
              is_private: isPrivate ?? false,
              name,
              team_id: slack.teamId,
            })
          );
          if (!(created.ok && created.channel)) {
            return {
              error: `Could not create the channel: ${created.error ?? 'unknown error'}`,
              success: false,
            };
          }
          const id = created.channel.id;
          // Enabled before the invite, so the requester's first message after
          // joining is already answered.
          await enableCodeChannel({ channelId: id, enabledBy: authorUserId });
          // The account made it, so it invites: the app can't join a private
          // one on its own, and without the app in it nothing is answered.
          // One call per person — Slack fails a whole batch on one
          // `already_in_channel`, which channel pairing can cause for the app.
          const invite = (user: string) =>
            account
              .apiCall('conversations.invite', { channel: id, users: user })
              .then(() => true)
              .catch((error: unknown) => {
                const message = errorMessage(error);
                if (message.includes('already_in_channel')) {
                  return true;
                }
                logger.warn(
                  { channel: id, error: message, user },
                  '[codeChannel] invite failed'
                );
                return false;
              });
          const appIn = slack.botUserId ? await invite(slack.botUserId) : false;
          const requesterIn = await invite(authorUserId);
          if (!appIn) {
            return {
              channel: `<#${id}>`,
              error: `Created <#${id}> but could not add myself to it, so I won't answer there.`,
              success: false,
            };
          }
          if (!requesterIn) {
            return {
              channel: `<#${id}>`,
              success: true,
              summary: `Created <#${id}> as a code channel, but could not invite you — join it from the channel link.`,
            };
          }
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
