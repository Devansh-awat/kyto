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
  /**
   * The latest message Jev judged not for kyto while this turn ran. It gets
   * the turn it would have had if kyto had been idle, once this one ends.
   */
  deferred?: TurnInput;
  /** What the turn is answering; unset for a `!secret` turn, which no check may read. */
  message?: Message;
  pendingMessages: TurnInput[];
  /** The author's own follow-ups, waiting for the next tool result (steering.ts). */
  steering: TurnInput[];
}
