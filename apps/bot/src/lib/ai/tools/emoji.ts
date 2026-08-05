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

export function submitEmojiTool({
  channelId,
  getSandboxContext,
  requestedBy,
}: {
  /** The workspace's emoji-request channel. */
  channelId: string;
  getSandboxContext: () => SandboxContext;
  requestedBy: string;
}) {
  return tool({
    description: `Submit a new custom emoji for the workspace: posts the image and the requested name into the emoji-request channel, where an admin adds it. The image must already be in your sandbox — generate or edit one first (generateImage), or download the one you were given. Slack's limits are 128x128 pixels and 128KB, so resize it in the sandbox first if it is bigger (ImageMagick: \`convert in.png -resize 128x128 out.png\`); this refuses anything over 128KB rather than posting something that will be thrown away.`,
    inputSchema: z.object({
      name: z
        .string()
        .min(2)
        .max(40)
        .describe(
          'The emoji name, lowercase, no colons — letters, digits, - _ + only.'
        ),
      note: z
        .string()
        .max(200)
        .optional()
        .describe('One short line about what it is, if it helps.'),
      path: z
        .string()
        .describe('Sandbox path of the image file (png or gif preferred).'),
    }),
    execute: async ({ name, note, path }) => {
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
        await slack.webClient.filesUploadV2({
          channel_id: channelId,
          file_uploads: [
            {
              file: Buffer.from(bytes),
              filename: `${cleaned}${extension}`,
            },
          ],
          // filesUploadV2 does NOT go through ThreadHandle.post, so the
          // deny-by-default broadcast strip does not apply here — and `note`
          // is model-written text going into a channel kyto was not invoked
          // in. Strip it explicitly or a `<!channel>` in that note pings the
          // whole emoji channel.
          initial_comment: neutralizeBroadcast(
            `\`:${cleaned}:\` — requested by <@${requestedBy}>${note ? `\n${note}` : ''}`
          ),
        });
        return {
          name: cleaned,
          submitted: true,
          summary: `Posted \`:${cleaned}:\` to the emoji-request channel. An admin has to add it before it works.`,
        };
      } catch (error) {
        logger.warn({ err: error, name: cleaned }, '[emoji] submission failed');
        return { error: errorMessage(error), submitted: false };
      }
    },
  });
}
