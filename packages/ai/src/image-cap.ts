import type { ModelMessage } from 'ai';

// A long browser turn screenshots and views image after image, and every one
// it views stays in the conversation for every later step. Past a provider's
// image limit the whole request is refused (`too_many_images`, a 400 no
// fallback can fix, since every rung gets the same pile), and before that each
// step re-sends megabytes of pixels it no longer needs.
export const MAX_CONTEXT_IMAGES = 8;

const DROPPED_NOTE =
  '[An earlier image was taken out of view here to stay under the image limit. viewImage it again if you still need it.]';

function isImagePart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null || !('type' in part)) {
    return false;
  }
  if (part.type === 'image') {
    return true;
  }
  return (
    part.type === 'file' &&
    'mediaType' in part &&
    typeof part.mediaType === 'string' &&
    part.mediaType.startsWith('image/')
  );
}

/**
 * Keep the newest `max` images in user messages and replace each older one
 * with a note, so the model knows it saw something there and how to get it
 * back. Returns the same array when nothing needed dropping, so a caller can
 * tell by identity and leave the cached prefix alone.
 */
export function capContextImages({
  max = MAX_CONTEXT_IMAGES,
  messages,
}: {
  max?: number;
  messages: ModelMessage[];
}): ModelMessage[] {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      total += message.content.filter(isImagePart).length;
    }
  }
  let toDrop = total - max;
  if (toDrop <= 0) {
    return messages;
  }
  return messages.map((message) => {
    if (
      toDrop <= 0 ||
      message.role !== 'user' ||
      !Array.isArray(message.content)
    ) {
      return message;
    }
    const content = message.content.map((part) => {
      if (toDrop > 0 && isImagePart(part)) {
        toDrop -= 1;
        return { text: DROPPED_NOTE, type: 'text' as const };
      }
      return part;
    });
    return { ...message, content };
  });
}
