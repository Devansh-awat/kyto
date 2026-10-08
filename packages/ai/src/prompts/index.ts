import { contextPrompt } from './context';
import { corePrompt } from './core';
import type { RequestHints } from './hints';
import { personalityPrompt } from './personality';
import { sandboxPrompt } from './sandbox';
import { slackPrompt } from './slack';

export type { RequestHints } from './hints';
export { subagentSystemPrompt } from './subagent';

// TWO system messages, not one: the static half is byte-identical in every
// thread, so it carries its own cache breakpoint (addCacheControl's A) and a new
// thread's first step reads it from cache; the context half names the thread,
// channel and the speaker's memories, so it can only be shared within a thread.
export function systemPrompt({ hints }: { hints: RequestHints }): string[] {
  return [
    [corePrompt, personalityPrompt, sandboxPrompt, slackPrompt]
      .filter(Boolean)
      .join('\n\n')
      .trim(),
    contextPrompt(hints).trim(),
  ];
}
