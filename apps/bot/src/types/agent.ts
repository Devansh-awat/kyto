import type { Message, ThreadHandle as Thread } from '@/harness';

export type AgentErrorStage = 'after_progress' | 'after_text' | 'before_output';

export interface TurnInput {
  /** Answer as kyto's Slack user account, like a person (lib/chat userBot). */
  asUserAccount?: boolean;
  message: Message;
  thread: Thread;
}

export type AbortReason = 'coding' | 'interrupt' | 'stop' | 'shutdown';

export interface ActiveTurn {
  controller: AbortController;
  pendingMessages: TurnInput[];
}
