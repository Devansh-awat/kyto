import { randomUUID } from 'node:crypto';

// A post that is about to go out but is waiting for the OWNER to physically
// click "Confirm & send" in an ephemeral message. Cross-channel posts and any
// post/edit made AS the owner are held here rather than executed inline, so a
// prompt injection can get as far as *asking* for the post but never actually
// send it — only a human click can. The store is in-memory and short-lived
// (the same philosophy as the rest of harness/kv.ts): a confirmation that does
// not survive a restart just expires, and the owner re-asks.

export type PendingPost =
  | {
      kind: 'postMessage';
      requestedBy: string;
      target: { type: 'thread' | 'channel' | 'user'; id: string };
      body: string;
      blocks?: unknown[];
      summary: string;
    }
  | {
      kind: 'sendAsUser';
      requestedBy: string;
      targetChannel: string;
      text: string;
      threadTs?: string;
      crossChannel: boolean;
      summary: string;
    }
  | {
      kind: 'editAsUser';
      requestedBy: string;
      targetChannel: string;
      messageTs: string;
      text: string;
      summary: string;
    };

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry {
  expiresAt: number;
  post: PendingPost;
}

const pending = new Map<string, Entry>();

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(id);
    }
  }
}

export function stashPendingPost(post: PendingPost): string {
  sweep();
  // Hard cap so a runaway loop of unconfirmed requests can't grow unbounded.
  if (pending.size >= MAX_ENTRIES) {
    const oldest = pending.keys().next().value;
    if (oldest) {
      pending.delete(oldest);
    }
  }
  const id = randomUUID();
  pending.set(id, { expiresAt: Date.now() + TTL_MS, post });
  return id;
}

export function takePendingPost(id: string): PendingPost | null {
  const entry = pending.get(id);
  if (!entry) {
    return null;
  }
  pending.delete(id);
  if (entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.post;
}
