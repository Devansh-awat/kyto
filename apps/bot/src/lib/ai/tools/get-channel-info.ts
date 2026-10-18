import { tool } from 'ai';
import { z } from 'zod';
import { bot, slack } from '@/lib/chat';
import { lookupFlaronChannel, searchFlaronChannels } from '@/lib/flaron';
import { toChatSlackChannelId, toRawSlackChannelId } from '@/lib/slack/ids';
import { assertReadableChannel } from './utils';

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
// "Exclude the bots" cost a 40-call users.info loop in the sandbox, 37s (#97).
// Lookups go through the harness's cached, deduplicated getUser, a few at a
// time (users.info is rate limited); past MAX_DETAILED only ids come back.
const MEMBER_PAGE = 1000;
const MAX_MEMBERS = 5000;
const MAX_DETAILED = 300;
const LOOKUP_CONCURRENCY = 10;

export function getChannelInfoTool({
  askerUserId,
  currentThreadId,
}: {
  askerUserId: string;
  currentThreadId: string;
}) {
  return tool({
    description:
      'Fetch metadata for a channel: name, member count, DM status, visibility (public/private), etc. Works for private channels kyto is not in too (name and visibility only, from the Flaron directory). Never call a channel public unless this says so. With `members: true` it also lists who is in it (each member\'s id, name and whether they are a bot) in one call: use it for "who is in this channel" and "everyone except the bots", never a users.info loop.',
    inputSchema: z.object({
      channelId: z.string(),
      members: z
        .boolean()
        .optional()
        .describe(
          `Also list the members (id, name, isBot). Names and bot flags for up to ${MAX_DETAILED}; ids only beyond that.`
        ),
    }),
    execute: async ({ channelId, members }) => {
      const chatChannelId = toChatSlackChannelId(channelId);
      try {
        const info = await assertReadableChannel(chatChannelId, {
          askerUserId,
          currentThreadId,
        });
        const base = {
          id: info.id,
          name: info.name,
          isDM: info.isDM ?? false,
          memberCount: info.memberCount,
          channelVisibility: info.channelVisibility,
        };
        if (!members) {
          return base;
        }
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await slack.webClient.conversations.members({
            channel: toRawSlackChannelId(chatChannelId),
            cursor,
            limit: MEMBER_PAGE,
          });
          ids.push(...(page.members ?? []));
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor && ids.length < MAX_MEMBERS);
        const detailed = ids.slice(0, MAX_DETAILED);
        const people: { id: string; isBot: boolean | null; name: string }[] =
          [];
        let next = 0;
        const worker = async () => {
          while (next < detailed.length) {
            const index = next++;
            const id = detailed[index] ?? '';
            const author = await bot.getUser(id);
            // A failed lookup leaves isBot unknown, never "human".
            people[index] = {
              id,
              isBot: author.isBot ?? null,
              name: author.userName,
            };
          }
        };
        await Promise.all(
          Array.from({ length: LOOKUP_CONCURRENCY }, () => worker())
        );
        const bots = people.filter((person) => person.isBot === true).length;
        const unknown = people.filter((person) => person.isBot === null).length;
        return {
          ...base,
          bots,
          members: people,
          ...(ids.length > MAX_DETAILED
            ? { moreMemberIds: ids.slice(MAX_DETAILED) }
            : {}),
          summary: `${ids.length}${cursor ? '+' : ''} members listed: ${people.length - bots - unknown} people, ${bots} bots${unknown > 0 ? `, ${unknown} unknown (lookup failed)` : ''}${ids.length > MAX_DETAILED ? `; ${ids.length - MAX_DETAILED} more as ids only` : ''}.`,
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
          // A private channel kyto isn't in reached Flaron as "nonexistent", and
          // with no next step kyto re-ran seven searches for 37s (#111).
          note: `${
            flaron.visibility === 'private'
              ? 'PRIVATE channel kyto is not in: only its name is known. Joining needs an invite from a member (or its managers).'
              : 'From the Flaron directory; kyto is not in this channel, and the bot cannot see it, so it is most likely private.'
          } readConversationHistory will fail on it unless the asker connected their own Slack. To look inside it, use searchSlack with \`in:<#${raw}>\` once: it searches with the asker's own access, so it finds messages there only if THEY are a member. Zero results means the asker can't see it or it isn't there: say so, don't retry with variants.`,
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
