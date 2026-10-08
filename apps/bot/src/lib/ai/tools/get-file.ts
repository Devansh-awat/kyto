import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { isSlackFileHost } from '@/harness/file-host';
import { slack } from '@/lib/chat';
import { sanitizeFilename } from '@/lib/utils/sanitize';

const SLACK_FILE_ID = /(F[A-Z0-9]{6,})/;
// Nothing here had a deadline, so one stalled download hung until the 5-min
// watchdog — and then hung again on every fallback model (#40).
const DOWNLOAD_TIMEOUT_MS = 90_000;
// The whole body is buffered on kyto's host before it goes to the sandbox.
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export function getFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      'Download a Slack file into the sandbox workspace so you can read it. Works for uploads, snippets, images, canvases, and any Slack file type. Accepts a Slack file URL, permalink, or file ID.',
    inputSchema: z.object({
      file: z
        .string()
        .min(1)
        .describe('A Slack file URL, permalink, or file ID (e.g. F0123ABCD).'),
      filename: z
        .string()
        .min(1)
        .optional()
        .describe('Optional name to save the file as.'),
    }),
    execute: async ({ file, filename }, { abortSignal }) => {
      const sandboxContext = getSandboxContext();
      if (!sandboxContext) {
        throw new Error('No active sandbox session is available.');
      }
      const signal = AbortSignal.any([
        ...(abortSignal ? [abortSignal] : []),
        AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ]);
      const timedOut = new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              new Error(
                `Downloading ${file} took over ${DOWNLOAD_TIMEOUT_MS / 1000}s and was stopped. Don't retry getFile for this file; tell the person it couldn't be downloaded.`
              )
            ),
          { once: true }
        );
      });
      // The timer fires long after a download that finished; without a
      // handler that late rejection would be an unhandled one.
      timedOut.catch(() => undefined);

      const fileId = SLACK_FILE_ID.exec(file)?.[1];
      const info = fileId
        ? (
            await Promise.race([
              slack.webClient.files.info({ file: fileId }),
              timedOut,
            ])
          ).file
        : undefined;
      if (info?.size && info.size > MAX_FILE_BYTES) {
        throw new Error(
          `${info.name ?? file} is ${Math.round(info.size / 1024 / 1024)} MB — over getFile's ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`
        );
      }
      const url =
        info?.url_private_download ??
        info?.url_private ??
        (file.startsWith('http') ? file : undefined);
      if (!url) {
        throw new Error(`Could not resolve a download URL for: ${file}`);
      }
      // Never attach the bot token to a non-Slack host. This tool is only for
      // Slack files; use fetchUrl (or bash/curl in the sandbox) for other URLs.
      if (!isSlackFileHost(url)) {
        throw new Error(
          'getFile only downloads Slack-hosted files. For any other URL use fetchUrl or fetch it from the sandbox — the bot token is never sent to a non-Slack host.'
        );
      }

      const response = await Promise.race([
        fetch(url, {
          headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
          signal,
        }),
        timedOut,
      ]);
      if (!response.ok) {
        throw new Error(`Failed to download Slack file: ${response.status}`);
      }
      const bytes = new Uint8Array(
        await Promise.race([response.arrayBuffer(), timedOut])
      );

      const name =
        sanitizeFilename(filename ?? info?.name ?? fileId ?? 'slack-file') ||
        'slack-file';
      const path = nodePath.join(
        sandboxContext.sessionWorkDir,
        'downloads',
        name
      );
      await sandboxContext.session.writeBinaryFile({ content: bytes, path });

      return {
        filename: name,
        mimeType: info?.mimetype,
        path,
        success: true,
        summary: `Downloaded ${name} to ${path}.`,
      };
    },
  });
}
