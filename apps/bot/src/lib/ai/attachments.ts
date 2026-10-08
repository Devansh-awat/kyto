import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import type { Message } from '@/harness/types';
import { sanitizeFilename } from '@/lib/utils/sanitize';
import type { SeededAttachment } from '@/types/attachments';

export async function seedAttachments({
  message,
  sandboxContext,
}: {
  message: Message;
  sandboxContext: SandboxContext;
}): Promise<SeededAttachment[]> {
  const seeded = await Promise.all(
    message.attachments.map((attachment, index) =>
      seedAttachment({ attachment, index, message, sandboxContext })
    )
  );
  return seeded.filter((entry): entry is SeededAttachment => entry !== null);
}

async function seedAttachment({
  attachment,
  index,
  message,
  sandboxContext,
}: {
  attachment: Message['attachments'][number];
  index: number;
  message: Message;
  sandboxContext: SandboxContext;
}): Promise<SeededAttachment | null> {
  const data = attachment.fetchData
    ? await attachment.fetchData()
    : attachment.data;
  if (!data) {
    return null;
  }

  const fallback = `attachment-${index + 1}`;
  const filename =
    sanitizeFilename(nodePath.basename(attachment.name || fallback)) ||
    fallback;
  const messageDir = sanitizeFilename(message.id) || 'message';
  const path = nodePath.join(
    sandboxContext.sessionWorkDir,
    'attachments',
    messageDir,
    filename
  );
  const bytes =
    data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : new Uint8Array(data);
  await sandboxContext.session.writeBinaryFile({ content: bytes, path });
  const visionType =
    bytes.byteLength <= MAX_VISION_BYTES &&
    VISION_MIME.test(attachment.mimeType ?? '')
      ? sniffImageType(bytes)
      : undefined;
  return {
    imageBytes: visionType ? bytes : undefined,
    mimeType: visionType ?? attachment.mimeType,
    name: filename,
    path,
    type: attachment.type,
  };
}

// Images the model can be shown directly. Capped so a giant upload doesn't blow
// up the request; the file is still on disk for the model to process in code.
const MAX_VISION_BYTES = 8 * 1024 * 1024;
const VISION_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

/**
 * The image type the BYTES say, not the name: Slack's mimetype follows the
 * extension, and a non-image renamed `.png` sent as image/png made the gateway
 * reject the whole request.
 */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (ascii(0, 4) === 'GIF8') {
    return 'image/gif';
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return;
}

export function promptWithAttachments({
  attachments,
  text,
}: {
  attachments: SeededAttachment[];
  text: string;
}): string {
  if (attachments.length === 0) {
    return text;
  }
  const lines = attachments.map(
    (attachment) =>
      `- ${attachment.name} (${attachment.type}${attachment.mimeType ? `, ${attachment.mimeType}` : ''}): ${attachment.path}`
  );
  return [
    text,
    '',
    'Attached files have already been downloaded into the sandbox workspace:',
    ...lines,
    'Use these local paths when reading, editing, or uploading the files.',
  ].join('\n');
}
