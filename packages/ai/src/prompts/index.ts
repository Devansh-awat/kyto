import { contextPrompt } from './context';
import { corePrompt, identityPrompt } from './core';
import type { RequestHints } from './hints';
import { personalityPrompt } from './personality';
import { sandboxPrompt } from './sandbox';
import { slackPrompt } from './slack';

export type { RequestHints } from './hints';

export function systemPrompt({ hints }: { hints: RequestHints }): string {
  return [
    identityPrompt,
    corePrompt,
    personalityPrompt,
    sandboxPrompt,
    slackPrompt,
    contextPrompt(hints),
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * System prompt for a subagent (runSubagentTool / recurring 'agent'
 * reminders when they launch their own subagent): the same operational
 * guidance (finishing the job, parallel tool calls, sandbox rules, tool
 * docs) minus `identityPrompt` (the "kyto is one of the best agents around"
 * self-framing, which reads oddly for a non-conversational delegate) and
 * minus `personalityPrompt` (tone-mirroring guidance irrelevant to a task
 * that never talks back to a user directly).
 */
export function subagentSystemPrompt({
  hints,
}: {
  hints: RequestHints;
}): string {
  return [corePrompt, sandboxPrompt, slackPrompt, contextPrompt(hints)]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}
