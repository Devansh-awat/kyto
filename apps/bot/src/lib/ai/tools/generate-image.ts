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

export function generateImageTool({
  upload,
}: {
  upload: (image: GeneratedImage) => Promise<void>;
}) {
  return tool({
    description:
      'Generate one or more AI images from a prompt and upload them to the current Slack thread. Use it for explicit image creation requests.',
    inputSchema: z.object({
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
    }),
    execute: async ({ n, prompt }) => {
      try {
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
          await upload({
            bytes,
            index,
            mediaType: detectMediaType(bytes),
            total,
          });
        }
        return {
          prompt,
          summary: `Generated and uploaded ${total} image${total === 1 ? '' : 's'} to this Slack thread.`,
          uploaded: total,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
