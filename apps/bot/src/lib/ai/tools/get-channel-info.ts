import { tool } from 'ai';
import { z } from 'zod';
import { lookupFlaronChannel, searchFlaronChannels } from '@/lib/flaron';
import { toChatSlackChannelId, toRawSlackChannelId } from '@/lib/slack/ids';
import { assertReadableChannel } from './utils';

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

export function getChannelInfoTool({
  currentThreadId,
}: {
  currentThreadId: string;
}) {
  return tool({
    description:
      'Fetch metadata for a channel: name, member count, DM status, visibility (public/private), etc. Works for private channels kyto is not in too (name and visibility only, from the Flaron directory). Never call a channel public unless this says so.',
    inputSchema: z.object({
      channelId: z.string(),
    }),
    execute: async ({ channelId }) => {
      const chatChannelId = toChatSlackChannelId(channelId);
      try {
        const info = await assertReadableChannel(chatChannelId, {
          currentThreadId,
        });
        return {
          id: info.id,
          name: info.name,
          isDM: info.isDM ?? false,
          memberCount: info.memberCount,
          channelVisibility: info.channelVisibility,
        };
      } catch (error) {
        // The bot can read the metadata of every public channel, so one it
        // can't see is most likely private — but "most likely" is how kyto
        // ended up telling the owner a private channel was public and
        // joinable. Ask a directory that knows instead of leaving it to guess.
        const raw = toRawSlackChannelId(chatChannelId);
        if (!CHANNEL_ID.test(raw)) {
          throw error;
        }
        const flaron = await lookupFlaronChannel({ id: raw }).catch(
          () => undefined
        );
        if (!flaron || flaron.visibility === 'unknown') {
          throw error;
        }
        return {
          ...flaron,
          kytoCanRead: false,
          note:
            flaron.visibility === 'private'
              ? 'PRIVATE channel kyto is not in: only its name is known. Joining needs an invite from a member (or its managers); kyto cannot read it.'
              : 'From the Flaron directory; kyto is not in this channel.',
        };
      }
    },
  });
}

export function findChannelsTool() {
  return tool({
    description:
      'Find Slack channels by name, from the public Flaron directory of Hack Club Slack. A partial name finds PUBLIC channels; an EXACT name also finds a private one (name and visibility only). Use getChannelInfo on a result for details.',
    inputSchema: z.object({
      query: z
        .string()
        .min(2)
        .describe('A channel name or part of one, e.g. "money-laundering".'),
    }),
    execute: async ({ query }) => {
      const name = query.replace(/^#/, '');
      // Flaron's search leaves private channels out; its by-name lookup does
      // not, so an exact name is tried too.
      const [matches, exact] = await Promise.all([
        searchFlaronChannels(name).catch(() => []),
        lookupFlaronChannel({ name }).catch(() => undefined),
      ]);
      const channels: {
        id: string;
        name: string;
        visibility?: string;
      }[] = matches.filter((channel) => channel.id !== exact?.id);
      if (exact?.name && exact.visibility !== 'nonexistent') {
        channels.unshift({
          id: exact.id,
          name: exact.name,
          visibility: exact.visibility,
        });
      }
      return {
        channels,
        summary: `Found ${channels.length} channel${channels.length === 1 ? '' : 's'} matching "${query}".`,
      };
    },
  });
}
