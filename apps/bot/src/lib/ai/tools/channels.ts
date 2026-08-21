import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
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
  isOwner,
  thread,
}: {
  isOwner: boolean;
  thread: Thread;
}) {
  return tool({
    description:
      "Set a Slack channel's topic and/or purpose. Provide topic, purpose, or both. Defaults to the current channel — and unless the bot owner is the one asking, the current channel is the ONLY channel you can set it on.",
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
