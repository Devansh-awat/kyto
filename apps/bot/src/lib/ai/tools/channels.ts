import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { creditChange } from '@/lib/slack/change-notice';
import { errorMessage } from '@/lib/utils/error';

const createChannelSchema = z.looseObject({
  channel: z
    .looseObject({ id: z.string().optional(), name: z.string().optional() })
    .optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});

const okSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
});

function channelIdFromThread(thread: Thread): string | undefined {
  const [platform, channelId] = thread.id.split(':');
  return platform === 'slack' ? channelId : undefined;
}

export function createChannelTool() {
  return tool({
    description:
      'Create a new public Slack channel. Use for "spin up a channel for X" requests. Returns the new channel id.',
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(80)
        .describe('Channel name (lowercase, no spaces; hyphens allowed).'),
      isPrivate: z
        .boolean()
        .default(false)
        .describe('Create a private channel instead of public.'),
    }),
    execute: async ({ name, isPrivate }) => {
      try {
        const result = createChannelSchema.parse(
          await slack.webClient.apiCall('conversations.create', {
            is_private: isPrivate,
            name,
          })
        );
        if (!result.ok) {
          return {
            error: `Channel creation failed: ${result.error}`,
            success: false,
          };
        }
        return {
          channelId: result.channel?.id,
          channelName: result.channel?.name,
          success: true,
          summary: `Created channel #${result.channel?.name ?? name}.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[createChannel] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

async function applyChannelField({
  channel,
  field,
  text,
}: {
  channel: string;
  field: 'purpose' | 'topic';
  text: string;
}): Promise<string | undefined> {
  const method =
    field === 'topic' ? 'conversations.setTopic' : 'conversations.setPurpose';
  const result = okSchema.parse(
    await slack.webClient.apiCall(method, { [field]: text, channel })
  );
  return result.ok ? undefined : (result.error ?? 'unknown error');
}

export function setChannelTopicTool({
  authorUserId,
  isOwner,
  thread,
}: {
  authorUserId: string;
  isOwner: boolean;
  thread: Thread;
}) {
  return tool({
    description:
      "Set a Slack channel's topic and/or purpose. Provide topic, purpose, or both. Defaults to the current channel, and unless the bot owner is the one asking, the current channel is the ONLY channel you can set it on.",
    inputSchema: z.object({
      topic: z
        .string()
        .min(1)
        .max(250)
        .optional()
        .describe('New channel topic text.'),
      purpose: z
        .string()
        .min(1)
        .max(250)
        .optional()
        .describe('New channel purpose/description text.'),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe('Target channel id. Defaults to the current channel.'),
    }),
    execute: async ({ topic, purpose, channelId }) => {
      try {
        if (!(topic || purpose)) {
          return {
            error: 'Provide a topic and/or a purpose to set.',
            success: false,
          };
        }
        const currentChannel = channelIdFromThread(thread);
        const targetChannel = channelId ?? currentChannel;
        if (!targetChannel) {
          return {
            error: 'Could not resolve a Slack channel.',
            success: false,
          };
        }
        // Same rule the postMessage tool follows: a non-owner may only act on
        // the channel kyto was actually invoked in. A topic change posts a
        // visible system message into the room, so an arbitrary channel id here
        // let anyone edit — and announce into — a channel they may have no
        // standing in and might not even be a member of.
        if (!isOwner && targetChannel !== currentChannel) {
          return {
            error:
              'Refused: only the bot owner can change another channel’s topic or purpose. Ask in that channel instead.',
            success: false,
          };
        }

        const applied: string[] = [];
        if (topic) {
          const error = await applyChannelField({
            channel: targetChannel,
            field: 'topic',
            text: topic,
          });
          if (error) {
            return { error: `Failed to set topic: ${error}`, success: false };
          }
          applied.push('topic');
          await creditChange({
            channel: targetChannel,
            requesterId: authorUserId,
            subtype: 'channel_topic',
          });
        }
        if (purpose) {
          const error = await applyChannelField({
            channel: targetChannel,
            field: 'purpose',
            text: purpose,
          });
          if (error) {
            return { error: `Failed to set purpose: ${error}`, success: false };
          }
          applied.push('purpose');
          await creditChange({
            channel: targetChannel,
            requesterId: authorUserId,
            subtype: 'channel_purpose',
          });
        }

        return {
          success: true,
          summary: `Set channel ${applied.join(' and ')}.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[setChannelTopic] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

const channelInfoSchema = z.looseObject({
  channel: z
    .looseObject({
      id: z.string().optional(),
      is_archived: z.boolean().optional(),
      is_im: z.boolean().optional(),
      is_member: z.boolean().optional(),
      is_mpim: z.boolean().optional(),
      is_private: z.boolean().optional(),
      name: z.string().optional(),
      properties: z
        .looseObject({
          posting_restricted_to: z
            .looseObject({ type: z.array(z.string()).optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});

// `posting_restricted_to.type` lists who may post: `ra` is every member (it's
// what #lounge has); a channel left to admins/owners plus a named list
// (#stardance-construction: admins and 55 people) is one most people can't
// post in, so kyto doesn't either.
const STAFF_POSTERS = new Set(['admin', 'owner']);

// Slack enforces the workspace's app and posting restrictions itself (an org
// admin's per-channel app limits are only readable with admin.* scopes kyto
// can't get), so its answer IS the permission check. These say why in words a
// person can act on.
const JOIN_ERRORS: Record<string, string> = {
  channel_not_found:
    "no such channel, or it's private (a private channel needs someone in it to `/invite @kyto`)",
  is_archived: 'the channel is archived',
  method_not_supported_for_channel_type:
    "that's not a channel kyto can join (a DM or group DM)",
  restricted_action:
    "the workspace's settings don't let apps join that channel. A workspace admin controls that",
};

export function joinChannelTool({ authorUserId }: { authorUserId: string }) {
  return tool({
    description:
      'Join a PUBLIC Slack channel as kyto (the app), when someone asks you to join or add yourself to a channel. This is channel membership. joinThread only follows a thread. A private channel can\'t be joined: someone in it has to `/invite @kyto`. After joining, it posts "kyto was added by @whoever-asked" in the channel, unless most people can\'t post there. Say you joined ONLY after this returns joined: true.',
    inputSchema: z.object({
      channelId: z
        .string()
        .min(1)
        .describe(
          'The channel id (C…), or its <#C…|name> mention. Look an id up first if you only have a name.'
        ),
    }),
    execute: async ({ channelId: raw }) => {
      const channel = /C[A-Z0-9]{6,}/.exec(raw)?.[0];
      if (!channel) {
        return {
          error: `"${raw}" isn't a channel id (C…). Find the channel's id first.`,
          joined: false,
        };
      }
      try {
        const info = channelInfoSchema.parse(
          await slack.webClient.apiCall('conversations.info', { channel })
        );
        const found = info.channel;
        if (info.ok && found?.is_member) {
          return { alreadyMember: true, channel, joined: true };
        }
        if (info.ok && (found?.is_private || found?.is_im || found?.is_mpim)) {
          return {
            error:
              "That channel is private, so kyto can't join it by itself: someone in it has to `/invite @kyto`.",
            joined: false,
          };
        }
        const joined = okSchema.parse(
          await slack.webClient.apiCall('conversations.join', { channel })
        );
        if (!joined.ok) {
          const code = joined.error ?? 'unknown_error';
          return {
            error: `Slack refused the join (${code}): ${JOIN_ERRORS[code] ?? 'see the error code'}.`,
            joined: false,
          };
        }
        // Who brought kyto in, said in the channel itself, but only where
        // people may post: the app could post in an announcement channel, but
        // nobody else there can.
        const posters = found?.properties?.posting_restricted_to?.type;
        if (posters?.every((type) => STAFF_POSTERS.has(type))) {
          return {
            announced: false,
            announceSkipped:
              'Most people can\'t post in this channel, so no "added by" note was posted.',
            channel,
            joined: true,
          };
        }
        const note = okSchema.parse(
          await slack.webClient
            .apiCall('chat.postMessage', {
              channel,
              text: `kyto was added by <@${authorUserId}>`,
            })
            .catch((error: unknown) => ({
              error: errorMessage(error),
              ok: false,
            }))
        );
        return {
          channel,
          joined: true,
          ...(note.ok
            ? { announced: true }
            : {
                announced: false,
                announceError: `The channel didn't take the "added by" note (${note.error ?? 'unknown error'}); posting there may be restricted.`,
              }),
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[joinChannel] failed');
        return { error: errorMessage(error), joined: false };
      }
    },
  });
}
