export interface RequestHints {
  botUserId?: string;
  channel?: {
    id?: string;
    name?: string;
  };
  customization?: { prompt: string; showUsageFooter?: boolean } | null;
  githubLogin?: string;
  // Every memory VISIBLE ON THIS TURN — the current person's own, plus the ones
  // the owner promoted to global. Titles only, so kyto knows what durable
  // knowledge exists and can fetch the full body when relevant.
  memories?: { title: string; createdBy?: string; isGlobal?: boolean }[];
  messageId?: string;
  ownerUserId?: string;
  threadId: string;
  time: string;
  workspace?: string;
}
