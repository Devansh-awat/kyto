import type { RequestHints } from './hints';

export function contextPrompt(hints: RequestHints): string {
  const lines = [`The current date and time is ${hints.time}.`];
  if (hints.botUserId) {
    lines.push(
      `Your own Slack user id is ${hints.botUserId}. A message that mentions <@${hints.botUserId}> (or @kyto) is addressed to YOU — never mistake it for another bot like gorkie. Never look this id up as a user.`
    );
  }
  if (hints.ownerUserId) {
    lines.push(
      `Your owner and creator is Devansh Awatramani (Slack <@${hints.ownerUserId}>) — he personally built and runs Kyto. If asked who made you, coded you, or owns you, state this plainly and don't hedge, deflect, or invent a different origin (e.g. "a team of engineers").`,
      "He owns and built KYTO — that is not a Slack role. Don't call him a workspace admin/owner, don't assume he has admin powers here, and don't route a workspace-admin question to him unless he says he is one."
    );
  }
  if (hints.workspace) {
    lines.push(`The current Slack workspace is ${hints.workspace}.`);
  }
  if (hints.channel?.name) {
    lines.push(`The current channel name is ${hints.channel.name}.`);
  }
  lines.push(`The current thread id is ${hints.threadId}.`);
  if (hints.channel?.id) {
    lines.push(`The current channel id is ${hints.channel.id}.`);
  }
  if (hints.messageId) {
    lines.push(`The message you're responding to has id ${hints.messageId}.`);
  }
  lines.push(
    'When earlier conversation context matters, fetch it with host tools instead of pretending you already saw it.'
  );
  return `<context>\n${lines.join('\n')}\n</context>${memoriesBlock(hints)}`;
}

// The workspace memory index: ONLY the title of each saved memory (kept cheap —
// no bodies or summaries ride in every prompt). kyto reads the titles to know
// what durable knowledge exists, then calls fetchMemory("<title>") to pull the
// full content of one that looks relevant. Saving is via saveMemory (after
// solving something big/non-obvious); editing via editMemory. Memories are
// shared across everyone and can never be deleted.
function memoriesBlock(hints: RequestHints): string {
  const memories = hints.memories ?? [];
  if (memories.length === 0) {
    return '';
  }
  const list = memories.map((memory) => `- ${memory.title}`).join('\n');
  return `\n\n<memories>\nDurable notes you (or a past thread) saved. These are just the TITLES — if one looks relevant to the task, read its full content with fetchMemory("<title>"), then update it with editMemory if needed. Save a new one with saveMemory after you work out something big or non-obvious that a future thread would want. Memories can't be deleted.\n${list}\n</memories>`;
}
