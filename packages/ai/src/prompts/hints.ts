export interface RequestHints {
  botUserId?: string;
  channel?: {
    id?: string;
    name?: string;
  };
  customization?: { prompt: string; showUsageFooter?: boolean } | null;
  // Title + one-line summary of every workspace memory, injected so kyto knows
  // what durable knowledge exists and can fetch the full body when relevant.
  memories?: { title: string; summary: string }[];
  messageId?: string;
  ownerUserId?: string;
  threadId: string;
  time: string;
  workspace?: string;
}
