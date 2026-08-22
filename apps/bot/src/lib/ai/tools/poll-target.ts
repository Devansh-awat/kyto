/**
 * Where a poll card lands, decided once so tests can pin it down.
 *
 * Top-level posts are gated exactly like postMessage's: only the owner starts
 * one. There is no API that reports a channel's posting restrictions, so for
 * everyone else a "channel" request is placed where they demonstrably could
 * have put it — the thread they are talking to kyto in — and the result says
 * so, so the model doesn't claim the poll went to the channel. When kyto was
 * invoked at channel level there is no thread to fall back into and both
 * values coincide.
 */
export function resolvePollTarget(
  postTo: 'thread' | 'channel',
  isOwner: boolean,
  threadTs: string | undefined
): { redirectedToThread: boolean; threadTs?: string } {
  return {
    redirectedToThread:
      postTo === 'channel' && !isOwner && threadTs !== undefined,
    threadTs: postTo === 'channel' && isOwner ? undefined : threadTs,
  };
}
