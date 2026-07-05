import type { Message, Thread } from 'chat';

export type AgentErrorStage = 'after_progress' | 'after_text' | 'before_output';

export interface TurnInput {
  message: Message;
  thread: Thread;
}

export type AbortReason = 'interrupt' | 'stop' | 'shutdown';

export interface ActiveTurn {
  // Running log of this turn's activity so far (model picked, tool calls,
  // etc.), appended to as StreamChunks are yielded — read by /btw so a
  // concurrent side question can answer "what is kyto doing right now"
  // without touching the turn itself. Capped in agent/index.ts.
  activityLog: string[];
  controller: AbortController;
  pendingMessages: TurnInput[];
}
