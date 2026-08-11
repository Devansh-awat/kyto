import nodePath from 'node:path/posix';
import {
  describeImages,
  type ImageInput,
  type SandboxContext,
  visionAttempt,
} from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { neutralizeBroadcast } from '@/harness';
import { slack } from '@/lib/chat';
import {
  addEmoji,
  emojiUploadConfigured,
  removeEmoji,
} from '@/lib/emoji-upload';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Custom emoji: reading what one actually IS, and submitting a new one.
//
// A workspace's custom emoji are a private language — a message that is mostly
// `:yay-parrot:` `:shipit-squirrel:` is meaningless to a model that only ever
// sees the NAME. `emoji.list` gives every name and its image URL, so kyto can
// fetch the picture and have the vision model tell it what it depicts.

// The emoji images live on emoji.slack-edge.com and are PUBLIC. They are fetched
// with no Authorization header at all — deliberately: getFile's rule is that the
// bot token only ever goes to Slack API hosts, and nothing here needs a token.
const EMOJI_LIST_TTL_MS = 30 * 60 * 1000;
const EMOJI_FETCH_TIMEOUT_MS = 10_000;
const MAX_EMOJI_BYTES = 512 * 1024;
const MAX_MATCHES = 25;

// Slack's own limits for a custom emoji image: 128x128 and 128KB. A submission
// larger than this is rejected by whoever adds it, so it is checked here rather
// than posted and quietly ignored.
const EMOJI_MAX_UPLOAD_BYTES = 128 * 1024;
const EMOJI_NAME = /^[a-z0-9][a-z0-9_+-]{1,39}$/;
const ALIAS_PREFIX = 'alias:';

// How long to wait for the emoji bot to answer in the submission's thread. It
// normally replies within a couple of seconds (":name: has been added"), and a
// submission that gets no reply at all is the case worth reporting, so kyto
// stops telling people an emoji exists when it doesn't.
const VERDICT_TIMEOUT_MS = 30_000;
const VERDICT_POLL_MS = 3000;
const VERDICT_HISTORY_SCAN = 10;

let cache: { at: number; emoji: Record<string, string> } | undefined;

async function emojiList(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < EMOJI_LIST_TTL_MS) {
    return cache.emoji;
  }
  const response = await slack.webClient.emoji.list({
    include_categories: false,
  });
  const emoji = (response.emoji ?? {}) as Record<string, string>;
  cache = { at: Date.now(), emoji };
  return emoji;
}

/** Follow `alias:other` chains to the name that actually carries an image. */
function resolveAlias(
  emoji: Record<string, string>,
  name: string
): { name: string; url?: string } {
  let current = name;
  for (let hop = 0; hop < 5; hop++) {
    const value = emoji[current];
    if (!value) {
      return { name: current };
    }
    if (!value.startsWith(ALIAS_PREFIX)) {
      return { name: current, url: value };
    }
    current = value.slice(ALIAS_PREFIX.length);
  }
  return { name: current };
}

export function lookupEmojiTool() {
  return tool({
    description:
      "Find out what a workspace custom emoji actually looks like. Give it an emoji name (with or without colons) and it resolves aliases, fetches the image, and describes what it depicts — use it when someone reacts with, or writes, an emoji whose name doesn't tell you what it is, or when you're picking one to use. Standard unicode emoji (:smile:) aren't here; this is the workspace's own uploaded ones. Pass a partial name to list matching emoji instead of describing one.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(80)
        .describe('The emoji name, e.g. "shipit" or ":shipit:".'),
      search: z
        .boolean()
        .default(false)
        .describe(
          'Treat the name as a substring and list matching emoji names instead of describing one.'
        ),
    }),
    execute: async ({ name, search }) => {
      const wanted = name.replace(/:/g, '').trim().toLowerCase();
      try {
        const emoji = await emojiList();
        if (search) {
          const matches = Object.keys(emoji)
            .filter((key) => key.includes(wanted))
            .slice(0, MAX_MATCHES);
          return {
            matches,
            summary:
              matches.length > 0
                ? `${matches.length} custom emoji match "${wanted}".`
                : `No custom emoji name contains "${wanted}".`,
          };
        }
        const resolved = resolveAlias(emoji, wanted);
        if (!resolved.url) {
          const near = Object.keys(emoji)
            .filter((key) => key.includes(wanted))
            .slice(0, 10);
          return {
            error: `No custom emoji named ":${wanted}:" in this workspace.${near.length > 0 ? ` Close names: ${near.join(', ')}.` : ' It may be a standard unicode emoji, which you already know.'}`,
            found: false,
          };
        }
        const response = await fetch(resolved.url, {
          signal: AbortSignal.timeout(EMOJI_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          return {
            found: true,
            name: resolved.name,
            summary: `":${wanted}:" exists but its image could not be fetched (${response.status}).`,
            url: resolved.url,
          };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_EMOJI_BYTES || !visionAttempt) {
          return {
            found: true,
            name: resolved.name,
            summary: `":${wanted}:" is a custom emoji${resolved.name === wanted ? '' : ` (an alias for :${resolved.name}:)`}. Image: ${resolved.url}`,
            url: resolved.url,
          };
        }
        const image: ImageInput = {
          bytes,
          mediaType: response.headers.get('content-type') ?? 'image/png',
          path: resolved.url,
        };
        const description = await describeImages({
          attempt: visionAttempt,
          images: [image],
          question: `This is a Slack custom emoji called ":${resolved.name}:". What does it show? Answer in one or two sentences, and say what it would MEAN when someone reacts with it.`,
        });
        return {
          alias: resolved.name === wanted ? undefined : resolved.name,
          description: description ?? undefined,
          found: true,
          name: wanted,
          url: resolved.url,
        };
      } catch (error) {
        return { error: errorMessage(error), found: false };
      }
    },
  });
}

/**
 * Wait for whatever the emoji bot says back about a submission.
 *
 * `filesUploadV2` doesn't hand back the ts of the message it created, so the
 * submission is found by scanning the channel's last few messages for kyto's own
 * post carrying exactly this name, then polling that message's thread.
 *
 * Why bother: the emoji bot sometimes answers with a CHOICE instead of adding it
 * ("upload as is" / "without background"), and that prompt is ephemeral to the
 * poster — kyto is the poster, a bot never receives ephemerals, and Slack has no
 * API for pressing a button on someone else's message with a bot OR a user
 * token. So kyto genuinely cannot complete that path, and the only honest thing
 * it can do is notice that nothing came back and say so instead of promising an
 * emoji that was never added.
 */
interface EmojiVerdict {
  /** Labels of the buttons the emoji bot offered, when it asked instead of adding. */
  choices?: string[];
  permalink?: string;
  text?: string;
}

/** Button labels out of a Block Kit `actions` block, if the reply carries one. */
function choiceLabels(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) {
    return [];
  }
  const labels: string[] = [];
  for (const block of blocks) {
    const record = block as { elements?: unknown; type?: unknown };
    if (record.type !== 'actions' || !Array.isArray(record.elements)) {
      continue;
    }
    for (const element of record.elements) {
      const label = (element as { text?: { text?: unknown } }).text?.text;
      if (typeof label === 'string' && label) {
        labels.push(label);
      }
    }
  }
  return labels;
}

async function awaitVerdict(
  channelId: string,
  name: string
): Promise<EmojiVerdict> {
  const history = await slack.webClient.conversations.history({
    channel: channelId,
    limit: VERDICT_HISTORY_SCAN,
  });
  const submission = (history.messages ?? []).find(
    (message) => message.text?.trim() === name && Boolean(message.files?.length)
  );
  const ts = submission?.ts;
  if (!ts) {
    return {};
  }
  const permalink = await slack.webClient.chat
    .getPermalink({ channel: channelId, message_ts: ts })
    .then((result) => result.permalink)
    .catch(() => undefined);
  const deadline = Date.now() + VERDICT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VERDICT_POLL_MS));
    const replies = await slack.webClient.conversations
      .replies({ channel: channelId, limit: 5, ts })
      .catch(() => null);
    const reply = (replies?.messages ?? []).find(
      (message) => message.ts !== ts && message.text
    );
    if (reply?.text) {
      const choices = choiceLabels(reply.blocks);
      return {
        ...(choices.length > 0 ? { choices } : {}),
        permalink,
        text: reply.text,
      };
    }
  }
  return { permalink };
}

/** Slack's own `emoji.add` error codes, in words the model can act on. */
function describeUploadError(code: string | undefined): string {
  switch (code) {
    case 'error_name_taken':
    case 'error_name_taken_i18n':
      return 'That emoji name is already taken. Pick another.';
    case 'error_bad_name_i18n':
      return 'Slack rejected that name. Use lowercase letters, digits, hyphens and underscores.';
    case 'error_bad_wide':
    case 'error_too_big':
      return 'The image is too large for Slack. Resize it to 128x128 and under 128KB, then try again.';
    case 'invalid_auth':
    case 'not_authed':
      return "Kyto's emoji session has expired — the bot owner needs to refresh it. Tell the user that, and do not retry.";
    case 'kyto_daily_limit':
      return 'That user has hit the daily limit for adding emoji through kyto. Tell them to try tomorrow.';
    case 'ratelimited':
      return 'Slack is rate limiting emoji uploads right now. Wait a minute and try again.';
    default:
      return `Slack refused the emoji upload: ${code ?? 'unknown error'}.`;
  }
}

export function submitEmojiTool({
  channelId,
  getSandboxContext,
  requestedBy,
}: {
  /** The workspace's emoji-request channel, when there is one to fall back to. */
  channelId?: string;
  getSandboxContext: () => SandboxContext;
  requestedBy: string;
}) {
  return tool({
    description: `Add a new custom emoji to the workspace. Where possible kyto adds it DIRECTLY and it is live immediately; otherwise it falls back to posting the image into the emoji channel with the name as the message text, which is the exact shape the emoji bot there reads — it does the adding. The image must already be in your sandbox: generate or edit one first (generateImage), or download the one you were given. PREFER AN IMAGE WITH NO BACKGROUND — the subject cut out on transparency, no square backdrop, no border. An emoji is rendered on whatever colour the message behind it is, so an opaque rectangle looks wrong in every theme; if what you have has a background, strip it in the sandbox before submitting (ImageMagick: \`convert in.png -fuzz 12% -transparent white -trim +repage out.png\`) and use PNG, which keeps the alpha channel. Slack's limits are 128x128 pixels and 128KB, so resize it first if it is bigger (ImageMagick: \`convert in.png -resize 128x128 out.png\`); this refuses anything over 128KB rather than posting something that gets thrown away. One emoji per call — the bot rejects a message carrying more than one image. It waits for the emoji bot's reply and hands it back, so read the result before telling anyone the emoji exists: that bot sometimes asks the poster to pick an option instead of adding it, and since the poster is me and Slack has no way for an app to press another app's button, only a human in that channel can finish it.`,
    inputSchema: z.object({
      name: z
        .string()
        .min(2)
        .max(40)
        .describe(
          'The emoji name, lowercase, no colons — letters, digits, - _ + only.'
        ),
      path: z
        .string()
        .describe('Sandbox path of the image file (png or gif preferred).'),
    }),
    execute: async ({ name, path }) => {
      const cleaned = name.replace(/:/g, '').trim().toLowerCase();
      if (!EMOJI_NAME.test(cleaned)) {
        return {
          error:
            'Invalid emoji name. Use lowercase letters, digits, hyphens, underscores or plus signs, 2-40 characters.',
          submitted: false,
        };
      }
      try {
        const context = getSandboxContext();
        const resolved = nodePath.normalize(
          path.startsWith('/')
            ? path
            : nodePath.join(context.sessionWorkDir, path)
        );
        const bytes = await Promise.resolve(
          context.session.readBinaryFile({ path: resolved })
        ).catch(() => null);
        if (!bytes) {
          return {
            error: `No file found at ${path}.`,
            submitted: false,
          };
        }
        if (bytes.byteLength > EMOJI_MAX_UPLOAD_BYTES) {
          return {
            error: `That image is ${Math.round(bytes.byteLength / 1024)}KB; Slack's limit for a custom emoji is 128KB (and 128x128 pixels). Resize it in the sandbox and try again.`,
            submitted: false,
          };
        }
        const extension = nodePath.extname(resolved) || '.png';
        // The direct path, when the owner's emoji session is configured: add it
        // ourselves rather than posting into a channel and hoping a bot picks
        // it up. Everything below is the fallback for when it is not.
        if (emojiUploadConfigured()) {
          const existing = await emojiList().catch(
            (): Record<string, string> => ({})
          );
          if (existing[cleaned]) {
            return {
              error: `\`:${cleaned}:\` already exists in this workspace. Pick another name.`,
              submitted: false,
            };
          }
          const result = await addEmoji({
            bytes,
            filename: `${cleaned}${extension}`,
            name: cleaned,
            requestedBy,
          });
          if (result.ok) {
            // The list is now stale, and lookupEmoji is what people use to
            // check whether the thing they just asked for exists.
            cache = undefined;
            return {
              name: cleaned,
              submitted: true,
              summary: `Added \`:${cleaned}:\` to the workspace for <@${requestedBy}>. It is live now — anyone can use it.`,
            };
          }
          return {
            error: describeUploadError(result.error),
            submitted: false,
          };
        }
        if (!channelId) {
          return {
            error:
              'Kyto cannot add emoji right now: its emoji session is not configured and this workspace has no emoji-request channel set. Tell the user to ask the bot owner.',
            submitted: false,
          };
        }
        await slack.webClient.filesUploadV2({
          channel_id: channelId,
          file_uploads: [
            {
              file: Buffer.from(bytes),
              filename: `${cleaned}${extension}`,
            },
          ],
          // The message text must be the BARE NAME and nothing else — that is
          // what the emoji bot in that channel parses (verified against the
          // channel's own history: `hedgehog`, `crack-ani`, `ember-sit-new`).
          // No colons, no "requested by", no note: any of those and the
          // submission is just a message nobody acts on.
          //
          // neutralizeBroadcast is belt and braces — EMOJI_NAME already makes a
          // control token unrepresentable — because filesUploadV2 does NOT go
          // through ThreadHandle.post, so the deny-by-default broadcast strip
          // never runs on this path.
          initial_comment: neutralizeBroadcast(cleaned),
        });
        // The channel only ever sees "kyto" as the poster — the message text has
        // to be the bare name, and a threaded "requested by …" note is not safe
        // either (the emoji bot parses thread REPLIES too: a reply of "gng" in
        // that channel removed an emoji that had just been added). So this log
        // line is the entire audit trail for who asked.
        logger.info(
          { name: cleaned, userId: requestedBy },
          '[emoji] submitted to the emoji channel'
        );
        const verdict: EmojiVerdict = await awaitVerdict(
          channelId,
          cleaned
        ).catch((): EmojiVerdict => ({}));
        // The bot sometimes ASKS instead of adding — a real in-thread message
        // (not ephemeral, as first assumed) carrying "as is" / "remove bg" /
        // "nvm" buttons. Slack has no API for one app to press another app's
        // button, with a bot token or a user token, so this is where kyto stops
        // and a human finishes it. Say that plainly rather than reporting the
        // question as if it were a verdict.
        if (verdict.choices && verdict.choices.length > 0) {
          return {
            choices: verdict.choices,
            name: cleaned,
            needsHuman: true,
            permalink: verdict.permalink,
            submitted: true,
            summary: `Posted \`${cleaned}\`, but the emoji bot is asking how to upload it (${verdict.choices.join(' / ')}) and only a human can press those buttons — Slack gives no way for one app to click another app's button. Tell whoever asked to open ${verdict.permalink ?? 'the emoji channel'} and pick an option, and do NOT say the emoji exists until lookupEmoji finds it.`,
          };
        }
        if (verdict.text) {
          return {
            name: cleaned,
            permalink: verdict.permalink,
            reply: verdict.text,
            submitted: true,
            summary: `Submitted \`${cleaned}\` for <@${requestedBy}>. The emoji bot replied: ${verdict.text}`,
          };
        }
        return {
          name: cleaned,
          permalink: verdict.permalink,
          submitted: true,
          summary: `Posted \`${cleaned}\` and its image to the emoji channel for <@${requestedBy}>, but the emoji bot has not answered in that thread yet. Tell the user it is posted but not confirmed, link them to ${verdict.permalink ?? 'the emoji channel'} so they can finish it, and do NOT claim the emoji exists until lookupEmoji finds it.`,
        };
      } catch (error) {
        logger.warn({ err: error, name: cleaned }, '[emoji] submission failed');
        return { error: errorMessage(error), submitted: false };
      }
    },
  });
}

/**
 * Remove a custom emoji. OWNER ONLY, and registered only for him.
 *
 * Two reasons it is not open like adding is. Slack only lets the account that
 * added an emoji remove it, and every emoji kyto adds goes in under the owner's
 * account — so "remove it" would mean anyone in the workspace could delete
 * anything kyto has ever added, for anyone. And removal is the destructive half:
 * an emoji someone is using in a saved message just disappears.
 */
export function removeEmojiTool({ requestedBy }: { requestedBy: string }) {
  return tool({
    description:
      'Remove a custom emoji from the workspace. Only works for emoji that were added through kyto (Slack only allows the adding account to remove one), and only the bot owner may do this. Destructive and immediate: the emoji vanishes from every message already using it, so confirm the name first with lookupEmoji.',
    inputSchema: z.object({
      name: z
        .string()
        .min(2)
        .max(40)
        .describe('The emoji name, lowercase, no colons.'),
    }),
    execute: async ({ name }) => {
      const cleaned = name.replace(/:/g, '').trim().toLowerCase();
      if (!EMOJI_NAME.test(cleaned)) {
        return { error: 'Invalid emoji name.', removed: false };
      }
      const result = await removeEmoji({ name: cleaned, requestedBy });
      if (!result.ok) {
        return {
          error:
            result.error === 'emoji_not_found'
              ? `There is no custom emoji called \`:${cleaned}:\`.`
              : describeUploadError(result.error),
          removed: false,
        };
      }
      cache = undefined;
      return {
        name: cleaned,
        removed: true,
        summary: `Removed \`:${cleaned}:\` from the workspace.`,
      };
    },
  });
}
