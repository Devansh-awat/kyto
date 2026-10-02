// kyto's notebooks: what it should know walking into a conversation, beyond
// the thread itself. One per channel (DMs included) and one workspace-wide.
// Only kevinton writes them (lib/kevinton/tools.ts), after a thread goes quiet.
//
// Who reads which (owner's call, 2026-10-02): the app loads only the channel's
// notebook; kyto's user account loads the channel's AND the global one. The
// global one therefore travels into every channel and DM the account is in,
// which is why a DM may never feed it (refused in the tool, not just asked)
// and a private channel feeds it only what kevinton judges isn't private.

export const GLOBAL_NOTEBOOK = 'global';
export const MAX_GLOBAL_NOTEBOOK_CHARS = 50_000;
export const MAX_CHANNEL_NOTEBOOK_CHARS = 20_000;

export type NotebookEdit =
  | { action: 'append'; text: string }
  | { action: 'replace'; find: string; text: string }
  | { action: 'rewrite'; text: string };

/**
 * One edit applied to a notebook's text, refused past the cap rather than
 * truncated: a silent cut would drop whatever happened to be at the end, and
 * the refusal tells kevinton to condense, which is the point of the cap.
 */
export function applyNotebookEdit({
  content,
  edit,
  max,
}: {
  content: string;
  edit: NotebookEdit;
  max: number;
}): { content: string } | { error: string } {
  let next: string;
  if (edit.action === 'append') {
    next = content.trim() ? `${content.trimEnd()}\n${edit.text}` : edit.text;
  } else if (edit.action === 'rewrite') {
    next = edit.text;
  } else {
    const at = content.indexOf(edit.find);
    if (!edit.find || at === -1) {
      return { error: '`find` is not in the notebook; read it again.' };
    }
    if (content.indexOf(edit.find, at + 1) !== -1) {
      return {
        error: '`find` appears more than once; include more text around it.',
      };
    }
    next =
      content.slice(0, at) + edit.text + content.slice(at + edit.find.length);
  }
  next = next.trim();
  if (next.length > max) {
    return {
      error: `That would make the notebook ${next.length} characters; the limit is ${max}. Condense it — merge entries, drop stale ones — with a rewrite.`,
    };
  }
  return { content: next };
}

/**
 * The prompt block for a turn: the channel's notebook, plus the global one when
 * answering as the user account. Empty when there is nothing to show.
 */
export async function renderNotebooks({
  channelId,
  includeGlobal,
}: {
  channelId: string;
  includeGlobal: boolean;
}): Promise<string> {
  // Imported here so the edit rule above is testable without a database env.
  const { getNotebooks } = await import('@repo/db/queries');
  const scopes = includeGlobal ? [GLOBAL_NOTEBOOK, channelId] : [channelId];
  const found = await getNotebooks(scopes);
  const blocks: string[] = [];
  const global = found.get(GLOBAL_NOTEBOOK)?.trim();
  if (includeGlobal && global) {
    blocks.push(`<notebook scope="workspace">\n${global}\n</notebook>`);
  }
  const channel = found.get(channelId)?.trim();
  if (channel) {
    blocks.push(`<notebook scope="this channel">\n${channel}\n</notebook>`);
  }
  if (blocks.length === 0) {
    return '';
  }
  return [
    "Your notebook — notes you kept from earlier conversations. Background only: it may be out of date, and the conversation in front of you wins where they disagree. Don't quote it at people or mention that it exists unless asked.",
    ...blocks,
  ].join('\n');
}
