import type { HarnessV1SandboxProvider, HarnessV1Skill } from '@ai-sdk/harness';
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createPi } from '@ai-sdk/harness-pi';
import type { ToolSet } from 'ai';
import { writeSystemPrompt } from './files/system';
import type { SandboxContext } from './types';
import type { PiAttempt } from './types/providers';

export function createAgent({
  attempt,
  onSandboxReady,
  sandbox,
  sessionId,
  skills,
  systemPrompt,
  tools,
}: {
  attempt: PiAttempt;
  onSandboxReady?: (input: SandboxContext) => PromiseLike<void> | void;
  sandbox: HarnessV1SandboxProvider;
  sessionId: string;
  skills: HarnessV1Skill[];
  systemPrompt: string;
  tools: ToolSet;
}) {
  const pi = createPi({
    auth: {
      customEnv: attempt.customEnv,
    },
    model: attempt.model,
    thinkingLevel: 'medium',
  });
  return new HarnessAgent({
    harness: pi,
    id: 'kyto',
    permissionMode: 'allow-all',
    sandbox,
    skills,
    tools,
    onSandboxSession: async ({ session, sessionWorkDir }) => {
      // `writeSystemPrompt` writes to a host tmp dir (not the sandbox), and
      // `onSandboxReady` only seeds attachments when the message has any — so
      // for a chat-only turn this hook never touches the sandbox, keeping the
      // lazy session unmaterialized. No session sync: we never persist.
      await onSandboxReady?.({ session, sessionWorkDir });
      await writeSystemPrompt({ sessionId, systemPrompt });
    },
  });
}

export type Agent = ReturnType<typeof createAgent>;
