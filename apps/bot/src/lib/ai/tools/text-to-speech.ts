import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { errorMessage } from '@/lib/utils/error';

// Gemini 3.1 Flash TTS via the native Interactions API (NOT the OpenAI-compat
// endpoint used elsewhere — TTS isn't exposed there). Confirmed against
// Google's own docs: POST .../v1beta/interactions with
// { model, input, response_format: { type: 'audio' }, generation_config:
// { speech_config: [{ voice }] } }, returning base64 PCM (24kHz, 16-bit,
// mono) in interaction.output_audio.data, which we wrap in a WAV header
// ourselves (no audio-processing dependency needed for that).
//
// The owner's Gemini key is capped at 10 TTS requests/day — there is no
// larger-quota alternative confirmed working yet (HackClub's Replicate proxy,
// which would otherwise cover this for free, currently 401s — see
// text-to-speech.ts callers / CLAUDE.md for the raw error).
const GEMINI_INTERACTIONS_URL =
  'https://generativelanguage.googleapis.com/v1beta/interactions';
const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

const VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Puck'] as const;

function wavHeader(pcmLength: number): Buffer {
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

export function textToSpeechTool({
  upload,
}: {
  upload: (input: { data: Buffer; filename: string }) => Promise<void>;
}) {
  return tool({
    description:
      "Convert text to spoken audio (Gemini 3.1 Flash TTS) and upload it to the thread as a .wav file. Capped at 10 requests/day on the owner's Gemini key, so use it deliberately, not for every reply.",
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'The text to speak. Can include natural-language style direction, e.g. "Say cheerfully: ...".'
        ),
      voice: z.enum(VOICES).default('Kore').describe('Prebuilt voice name.'),
    }),
    execute: async ({ text, voice }) => {
      if (!env.GEMINI_API_KEY) {
        return {
          error: 'Text-to-speech requires GEMINI_API_KEY to be configured.',
          success: false,
        };
      }
      try {
        const response = await fetch(GEMINI_INTERACTIONS_URL, {
          body: JSON.stringify({
            generation_config: { speech_config: [{ voice }] },
            input: text,
            model: TTS_MODEL,
            response_format: { type: 'audio' },
          }),
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY,
          },
          method: 'POST',
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            error: `Gemini TTS request failed (${response.status}): ${body.slice(0, 500)}`,
            success: false,
          };
        }
        const payload = (await response.json()) as {
          output_audio?: { data?: string; mime_type?: string };
        };
        const base64 = payload.output_audio?.data;
        if (!base64) {
          return { error: 'Gemini TTS returned no audio.', success: false };
        }
        const pcm = Buffer.from(base64, 'base64');
        const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
        const filename = `kyto-speech-${Date.now()}.wav`;
        await upload({ data: wav, filename });
        return { filename, success: true };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
