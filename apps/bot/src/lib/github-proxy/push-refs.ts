// The refs a `git push` updates, read from the head of its receive-pack
// request: pkt-lines of `<old> <new> <ref>[\0caps]\n` up to a flush, then the
// pack. The shared-fork rule (guard.ts) needs them, and they exist nowhere
// else — the command text can say `git push origin HEAD:anything`.

/** Peek at most this much before giving up on finding the command list. */
const MAX_PEEK_BYTES = 64 * 1024;

const COMMAND = /^[0-9a-f]{40,64} [0-9a-f]{40,64} (refs\/\S+)$/;

/**
 * The refs, `undefined` while the command list isn't complete yet, or null when
 * it isn't one (malformed, a push certificate, a compressed body) — which the
 * caller must treat as "can't tell", never as "no refs".
 */
export function parsePushCommands(
  head: Uint8Array
): string[] | null | undefined {
  const buffer = Buffer.from(head);
  const refs: string[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = Number.parseInt(
      buffer.toString('latin1', offset, offset + 4),
      16
    );
    if (Number.isNaN(size) || (size > 0 && size < 4)) {
      return null;
    }
    if (size === 0) {
      return refs;
    }
    if (offset + size > buffer.length) {
      return;
    }
    const line = buffer
      .toString('utf8', offset + 4, offset + size)
      .split('\0')[0]
      ?.replace(/\n$/, '');
    offset += size;
    if (line?.startsWith('shallow ')) {
      continue;
    }
    const ref = COMMAND.exec(line ?? '')?.[1];
    if (!ref) {
      return null;
    }
    refs.push(ref);
  }
  return;
}

/**
 * Read just far enough into a push to list its refs, and hand back a stream
 * that replays what was read followed by the rest, so the pack is still
 * streamed to GitHub rather than buffered whole.
 */
export async function peekPushRefs(
  stream: ReadableStream<Uint8Array>
): Promise<{ body: ReadableStream<Uint8Array>; refs: string[] | null }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let refs: string[] | null | undefined;
  while (refs === undefined && size < MAX_PEEK_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.byteLength;
    refs = parsePushCommands(Buffer.concat(chunks));
  }
  const body = new ReadableStream<Uint8Array>({
    cancel: (reason) => reader.cancel(reason),
    async pull(controller) {
      const next = chunks.shift();
      if (next) {
        controller.enqueue(next);
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
  });
  return { body, refs: refs ?? null };
}
