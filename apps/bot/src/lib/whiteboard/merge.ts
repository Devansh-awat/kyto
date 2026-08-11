// Which copy of a shape wins when two people draw at once.
//
// This is the whole of the sync algorithm, and it is Excalidraw's own: every
// element carries a `version` that increments on each edit and a random
// `versionNonce`. Higher version wins; a tie is broken by the higher nonce,
// which is arbitrary but IDENTICAL on every peer — that is what stops two
// clients settling on different answers and drifting apart forever.
//
// A delete is not a removal, it is an element with `isDeleted: true` and a
// higher version. Dropping the record instead would let a peer that still holds
// the older copy resurrect it on its next edit.

export interface BoardElement {
  id: string;
  isDeleted?: boolean;
  version?: number;
  versionNonce?: number;
  [key: string]: unknown;
}

/** True when `incoming` should replace `existing`. */
function isNewer({
  existing,
  incoming,
}: {
  existing: BoardElement | undefined;
  incoming: BoardElement;
}): boolean {
  if (!existing) {
    return true;
  }
  const existingVersion = existing.version ?? 0;
  const incomingVersion = incoming.version ?? 0;
  if (incomingVersion !== existingVersion) {
    return incomingVersion > existingVersion;
  }
  // Same version, two different edits: pick deterministically rather than
  // "last writer wins", which depends on arrival order and so differs per peer.
  return (incoming.versionNonce ?? 0) > (existing.versionNonce ?? 0);
}

/**
 * Fold `incoming` into `board`, in place. Returns the elements that actually
 * changed something, so only those are broadcast and only they mark the board
 * dirty — a client re-sending what everyone already has costs nothing.
 */
export function mergeElements({
  board,
  incoming,
}: {
  board: Map<string, BoardElement>;
  incoming: readonly BoardElement[];
}): BoardElement[] {
  const applied: BoardElement[] = [];
  for (const element of incoming) {
    if (typeof element?.id !== 'string') {
      continue;
    }
    if (isNewer({ existing: board.get(element.id), incoming: element })) {
      board.set(element.id, element);
      applied.push(element);
    }
  }
  return applied;
}
