import type { ThreadHandle as Thread } from '@/harness/thread';
import type { Message } from '@/harness/types';

export type AgentErrorStage = 'after_progress' | 'after_text' | 'before_output';

export interface TurnInput {
  /** Answer as kyto's Slack user account, like a person (lib/chat userBot). */
  asUserAccount?: boolean;
  message: Message;
  thread: Thread;
}

export type AbortReason = 'interrupt' | 'stop' | 'shutdown';

export interface ActiveTurn {
  controller: AbortController;
  pendingMessages: TurnInput[];
}
