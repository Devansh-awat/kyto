import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createAgent,
  geminiAttempt,
  openSession,
  type SandboxContext,
  subagentSystemPrompt,
} from '@repo/ai';
import { loadSkills } from '@repo/sandbox';
import { tool } from 'ai';
import type { Chat, Message, Thread } from 'chat';
import { z } from 'zod';
import { sandbox } from '@/lib/agent/sandbox';
import { requestHints } from '@/lib/ai/hints';
import { errorMessage } from '@/lib/utils/error';

// A subagent is kyto itself — same full Pi harness, same sandbox, same
// complete toolset (including this very tool, so it can delegate further) —
// apart from two deliberate differences: it's pinned to the owner's own
// Gemini key (gemini-3.1-flash-lite) rather than openrouter/auto/HackClub,
// and it runs `subagentSystemPrompt` instead of the normal `systemPrompt`
// (drops the "kyto is one of the best agents around" self-framing and the
// tone-mirroring personality guidance, neither of which make sense for a
// one-shot delegate that never talks to a user directly). This makes it a
// genuine, if smaller/cheaper, kyto instance rather than a stripped-down
// research-only loop (the tool's original design).
//
// Since it can spawn its own subagents recursively, depth is capped via
// AsyncLocalStorage — a runaway recursive spawn would otherwise be a real
// cost/time risk with no natural backstop.
const SUBAGENT_MODEL = 'gemini-3.1-flash-lite';
const MAX_SUBAGENT_DEPTH = 2;

const depthStore = new AsyncLocalStorage<number>();

export function runSubagentTool({
  bot,
  message,
  thread,
}: {
  bot: Chat;
  message: Message;
  thread: Thread;
}) {
  return tool({
    description:
      'Delegate a task to a subagent — a full copy of kyto (same sandbox, same tools, can even delegate further) except it runs on a cheaper pinned model and has no "chat personality" framing, since it never talks to a user directly. Use it for open-ended investigation or self-contained work that would otherwise clutter your own context. Returns a written report.',
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .describe(
          'The task to delegate, with as much detail/context as the subagent will need (it has no access to this conversation beyond what you pass here).'
        ),
    }),
    execute: async ({ task }) => {
      const depth = depthStore.getStore() ?? 0;
      if (depth >= MAX_SUBAGENT_DEPTH) {
        return {
          error: `Subagent nesting limit (${MAX_SUBAGENT_DEPTH}) reached — cannot delegate further.`,
          success: false,
        };
      }
      try {
        return await depthStore.run(depth + 1, async () => {
          const hints = await requestHints({ message, thread });
          const skills = await loadSkills();
          let sandboxContext: SandboxContext | undefined;
          // Import lazily to avoid a hard circular-import cycle at module
          // load time (toolset.ts registers this tool; this tool needs
          // toolset.ts's buildTools to give the subagent its own full set).
          const { buildTools } = await import('@/lib/ai/toolset');
          const tools = buildTools({
            bot,
            getSandboxContext: () => sandboxContext,
            message,
            thread,
          });
          const subagentSessionId = `${thread.id}-subagent-${crypto.randomUUID()}`;
          const agent = createAgent({
            attempt: geminiAttempt(SUBAGENT_MODEL),
            onSandboxReady: (context) => {
              sandboxContext = context;
            },
            sandbox,
            sessionId: subagentSessionId,
            skills,
            systemPrompt: subagentSystemPrompt({ hints }),
            tools,
          });
          const session = await openSession({
            agent,
            threadId: subagentSessionId,
          });
          try {
            const result = await agent.generate({ prompt: task, session });
            const report = result.text.trim();
            if (report) {
              return { report, success: true };
            }
            if (result.toolCalls.length > 0) {
              return {
                report: '(Completed actions with no additional message.)',
                success: true,
              };
            }
            return {
              error: 'Subagent produced an empty report.',
              success: false,
            };
          } finally {
            await session.destroy().catch(() => undefined);
          }
        });
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
