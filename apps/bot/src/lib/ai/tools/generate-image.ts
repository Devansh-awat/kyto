import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { errorMessage } from '@/lib/utils/error';
import type { GeneratedImage } from '@/types/tools/generate-image';

// Image generation goes straight to HackClub's OpenAI-compatible
// `/images/generations` endpoint (model google/gemini-3.1-flash-image), which
// is verified working and billed to HACKCLUB_API_KEY. We call it directly with
// fetch rather than through the AI SDK's `generateImage` + OpenRouter provider,
// whose image path did not actually reach this endpoint (the "image gen not
// working" bug).
//
// This is deliberately the SERVICE image provider even on a BYOK turn: a user's
// stored key is a chat-completions credential (we never asked them for an
// image-capable one, and most aren't), so routing images at it would just fail.
// Image generation therefore always spends the service budget, regardless of
// whose key is answering the rest of the turn.
const IMAGES_URL = 'https://ai.hackclub.com/proxy/v1/images/generations';
const IMAGE_MODEL = 'google/gemini-3.1-flash-image';

// EDITING an existing image goes somewhere else entirely. The OpenAI-shaped
// `/images/edits` route 404s on this proxy (verified 2026-08-05), but the same
// model accepts an image on CHAT completions and answers with one, provided the
// request asks for the image modality — the reply then carries the result in
// `message.images[].image_url.url` as a data URI rather than in `content`.
// That is the path every "make this X" / "add Y to this picture" request takes.
const CHAT_URL = 'https://ai.hackclub.com/proxy/v1/chat/completions';
// Beyond this, a request is more likely to time out than to succeed, and each
// image is inlined as base64.
const MAX_INPUT_IMAGES = 4;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

const DATA_URI = /^data:([^;,]+);base64,(.+)$/s;

// Detect the media type from the decoded bytes' magic number so Slack shows the
// right file type (this endpoint returns JPEG, but don't hard-code it).
function detectMediaType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return 'image/png';
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49) {
    return 'image/webp';
  }
  return 'image/png';
}

// Every generated image is written to the workspace as well as (optionally)
// posted: an upload that fails, or a picture the model wants to edit or serve
// from a site, is otherwise gone the moment the call returns. Best effort — a
// sandbox that won't take the write must not fail the generation.
async function saveToSandbox({
  bytes,
  getSandboxContext,
  index,
  mediaType,
}: {
  bytes: Uint8Array;
  getSandboxContext: () => SandboxContext;
  index: number;
  mediaType: string;
}): Promise<string | null> {
  const extension = mediaType.split('/').at(1) ?? 'png';
  try {
    const context = getSandboxContext();
    const path = nodePath.join(
      context.sessionWorkDir,
      'generated-images',
      `kyto-image-${Date.now()}-${index + 1}.${extension}`
    );
    await context.session.writeBinaryFile({ content: bytes, path });
    return path;
  } catch {
    return null;
  }
}

/**
 * Edit existing image(s): send them to the image model on chat completions and
 * pull the returned image back out. Returns the raw bytes of every image the
 * model produced.
 */
async function editImages({
  images,
  prompt,
}: {
  images: { bytes: Uint8Array; mediaType: string }[];
  prompt: string;
}): Promise<{ bytes: Uint8Array[]; error?: string }> {
  const response = await fetch(CHAT_URL, {
    body: JSON.stringify({
      messages: [
        {
          content: [
            { text: prompt, type: 'text' },
            ...images.map((image) => ({
              image_url: {
                url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`,
              },
              type: 'image_url',
            })),
          ],
          role: 'user',
        },
      ],
      // Without this the model answers in prose ABOUT the image instead of
      // returning one.
      modalities: ['image', 'text'],
      model: IMAGE_MODEL,
    }),
    headers: {
      Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      bytes: [],
      error: `Image editing failed (${response.status}): ${body.slice(0, 300)}`,
    };
  }
  const payload = (await response.json()) as {
    choices?: {
      message?: {
        content?: string;
        images?: { image_url?: { url?: string } }[];
      };
    }[];
  };
  const message = payload.choices?.at(0)?.message;
  const out: Uint8Array[] = [];
  for (const entry of message?.images ?? []) {
    const match = DATA_URI.exec(entry.image_url?.url ?? '');
    if (match?.[2]) {
      out.push(Uint8Array.from(Buffer.from(match[2], 'base64')));
    }
  }
  if (out.length === 0) {
    return {
      bytes: [],
      error: `The image model returned no image${message?.content ? `. It said: ${message.content.slice(0, 300)}` : '.'}`,
    };
  }
  return { bytes: out };
}

/**
 * The edit path end to end: read the inputs out of the sandbox, send them to
 * the model, then save (and optionally post) whatever came back.
 */
async function runEdit({
  editPaths,
  getSandboxContext,
  prompt,
  shouldUpload,
  upload,
}: {
  editPaths: string[];
  getSandboxContext: () => SandboxContext;
  prompt: string;
  shouldUpload: boolean;
  upload: (image: GeneratedImage) => Promise<void>;
}) {
  const context = getSandboxContext();
  const inputs: { bytes: Uint8Array; mediaType: string }[] = [];
  for (const path of editPaths) {
    const bytes = await Promise.resolve(
      context.session.readBinaryFile({ path })
    ).catch(() => null);
    if (!bytes) {
      return {
        error: `Could not read "${path}" from the sandbox. Check the path — an image someone posted is downloaded into your workspace, and listing the directory will show its real name.`,
        success: false,
      };
    }
    if (bytes.length > MAX_INPUT_BYTES) {
      return {
        error: `"${path}" is ${Math.round(bytes.length / 1024 / 1024)}MB, too large to send for editing. Resize it below 8MB first.`,
        success: false,
      };
    }
    inputs.push({ bytes, mediaType: detectMediaType(bytes) });
  }
  const edited = await editImages({ images: inputs, prompt });
  if (edited.error) {
    return { error: edited.error, success: false };
  }
  const total = edited.bytes.length;
  const paths: string[] = [];
  let uploaded = 0;
  for (const [index, bytes] of edited.bytes.entries()) {
    const mediaType = detectMediaType(bytes);
    const saved = await saveToSandbox({
      bytes,
      getSandboxContext,
      index,
      mediaType,
    });
    if (saved) {
      paths.push(saved);
    }
    if (shouldUpload) {
      await upload({ bytes, index, mediaType, total });
      uploaded += 1;
    }
  }
  const plural = total === 1 ? '' : 's';
  return {
    paths,
    prompt,
    summary: shouldUpload
      ? `Edited ${editPaths.length} image${editPaths.length === 1 ? '' : 's'} and posted ${total} result${plural} to this Slack thread (also saved: ${paths.join(', ') || 'none'}).`
      : `Edited ${editPaths.length} image${editPaths.length === 1 ? '' : 's'} into ${total} result${plural} in the sandbox (not posted): ${paths.join(', ') || 'none'}.`,
    uploaded,
  };
}

export function generateImageTool({
  getSandboxContext,
  upload,
}: {
  /** Where generated images are saved, so they survive an upload that fails. */
  getSandboxContext: () => SandboxContext;
  upload: (image: GeneratedImage) => Promise<void>;
}) {
  return tool({
    description:
      'Generate or EDIT AI images. With just a prompt it generates from scratch. Pass `editPaths` (sandbox file paths to existing images — an image someone sent you is already downloaded into your workspace) to edit them instead: "make the background blue", "add a hat", "combine these two", "turn this sketch into a photo". By default the result is posted to the current Slack thread; pass upload:false to work quietly (e.g. an asset for a site, or an intermediate step). Either way every image is saved into your sandbox workspace and the paths come back in the result, so you can edit it again, reuse it, or upload it later.',
    inputSchema: z.object({
      editPaths: z
        .array(z.string())
        .max(MAX_INPUT_IMAGES)
        .optional()
        .describe(
          'Sandbox paths of existing images to EDIT rather than generating from scratch. Several paths are given to the model together, so it can combine them. `n` is ignored when editing.'
        ),
      n: z
        .number()
        .int()
        .min(1)
        .max(4)
        .default(1)
        .describe('How many images to generate.'),
      prompt: z
        .string()
        .min(1)
        .max(1500)
        .describe('What to generate, with the visual details.'),
      upload: z
        .boolean()
        .default(true)
        .describe(
          'Post the images to this Slack thread. Set false to only save them to the sandbox.'
        ),
    }),
    execute: async ({ editPaths, n, prompt, upload: shouldUpload }) => {
      try {
        if (editPaths && editPaths.length > 0) {
          return await runEdit({
            editPaths,
            getSandboxContext,
            prompt,
            shouldUpload,
            upload,
          });
        }
        const response = await fetch(IMAGES_URL, {
          body: JSON.stringify({ model: IMAGE_MODEL, n, prompt }),
          headers: {
            Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            error: `Image generation failed (${response.status}): ${body.slice(0, 300)}`,
            success: false,
          };
        }
        const payload = (await response.json()) as {
          data?: { b64_json?: string; url?: string }[];
        };
        const entries = payload.data ?? [];
        if (entries.length === 0) {
          return {
            error: 'Image generation returned no images.',
            success: false,
          };
        }
        const total = entries.length;
        const paths: string[] = [];
        let uploaded = 0;
        for (const [index, entry] of entries.entries()) {
          let bytes: Uint8Array | undefined;
          if (entry.b64_json) {
            bytes = Uint8Array.from(Buffer.from(entry.b64_json, 'base64'));
          } else if (entry.url) {
            const img = await fetch(entry.url);
            bytes = new Uint8Array(await img.arrayBuffer());
          }
          if (!bytes) {
            continue;
          }
          const mediaType = detectMediaType(bytes);
          const saved = await saveToSandbox({
            bytes,
            getSandboxContext,
            index,
            mediaType,
          });
          if (saved) {
            paths.push(saved);
          }
          if (shouldUpload) {
            await upload({ bytes, index, mediaType, total });
            uploaded += 1;
          }
        }
        const plural = total === 1 ? '' : 's';
        return {
          paths,
          prompt,
          summary: shouldUpload
            ? `Generated and uploaded ${total} image${plural} to this Slack thread (also saved in the sandbox: ${paths.join(', ') || 'none'}).`
            : `Generated ${total} image${plural} in the sandbox (not posted to Slack): ${paths.join(', ') || 'none'}.`,
          uploaded,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
