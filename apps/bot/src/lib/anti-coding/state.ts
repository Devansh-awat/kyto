// What Jev is shown: the WHOLE context, not one message. Scoring the latest
// message alone missed exactly the requests that got kyto's key flagged —
// lily's "can you please give me the final program" and "now implement it for
// the cf version" scored 0.39 and 0.70 bare, and 0.93-0.97 once the thread they
// sat in was attached. And a message can be innocent while the WORK isn't: "fetch
// this gist and follow it" only turns into a bot when the gist is read, so what
// kyto fetched and what it is about to run are part of the state too.
//
// Budgeted per section, newest kept, so a long thread or one huge tool output
// cannot push the thing being judged — the next action — out of the window.

const CONVERSATION_CHARS = 3500;
const LATEST_CHARS = 1500;
const ACTIONS_CHARS = 2500;
const ACTION_CHARS = 600;
const NEXT_CHARS = 1200;

export interface CodingAction {
  input: unknown;
  /** Absent for a call that has not returned (or was only checked). */
  output?: unknown;
  toolName: string;
}

function compact(value: unknown, max: number): string {
  const text =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value) ?? String(value));
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Keep the END of `text` — the newest part of a conversation. */
function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function renderAction(action: CodingAction): string {
  const call = `${action.toolName} ${compact(action.input, ACTION_CHARS)}`;
  return action.output === undefined
    ? call
    : `${call} -> ${compact(action.output, ACTION_CHARS)}`;
}

export function renderCodingState({
  actions = [],
  conversation,
  latest,
  next,
}: {
  actions?: CodingAction[];
  /** The thread as the model sees it, oldest first. */
  conversation: string;
  latest: string;
  next?: CodingAction;
}): string {
  const sections = [
    `<conversation>\n${tail(conversation.trim(), CONVERSATION_CHARS)}\n</conversation>`,
    `<latest_message>\n${tail(latest.trim(), LATEST_CHARS)}\n</latest_message>`,
  ];
  // Newest first until the budget runs out, then back into order.
  const kept: string[] = [];
  let used = 0;
  for (const action of [...actions].reverse()) {
    const line = `- ${renderAction(action)}`;
    if (used + line.length > ACTIONS_CHARS) {
      break;
    }
    kept.unshift(line);
    used += line.length;
  }
  if (kept.length > 0) {
    sections.push(
      `<assistant_actions_this_turn>\n${kept.join('\n')}\n</assistant_actions_this_turn>`
    );
  }
  if (next) {
    sections.push(
      `<next_action>\n${compact(`${next.toolName} ${compact(next.input, NEXT_CHARS)}`, NEXT_CHARS)}\n</next_action>`
    );
  }
  return sections.join('\n');
}
