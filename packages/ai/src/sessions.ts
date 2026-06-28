import type { HarnessAgentSession } from '@ai-sdk/harness/agent';
import type { Agent } from './agent';

/**
 * Open a fresh, non-persisted Pi session for a turn. We deliberately never
 * resume: the Slack thread is the single source of conversation memory (the
 * whole thread is fed into each turn's prompt), so nothing is stored between
 * turns. The session is torn down at turn end via `session.destroy()`.
 */
export function openSession({
  agent,
  threadId,
}: {
  agent: Agent;
  threadId: string;
}): Promise<HarnessAgentSession> {
  return agent.createSession({ sessionId: threadId });
}
