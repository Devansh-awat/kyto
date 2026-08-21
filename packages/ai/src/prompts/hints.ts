export interface RequestHints {
  botUserId?: string;
  channel?: {
    id?: string;
    name?: string;
  };
  /** Channel groups this channel belongs to — what a group-scoped memory or a
   *  shared MCP server is attached to. Ids only; the prompt names the group. */
  channelGroupIds?: string[];
  customization?: { prompt: string; showUsageFooter?: boolean } | null;
  // kyto's own email address (AgentMail inbox), resolved once and cached — it
  // never changes, so it rides in every prompt without a per-turn lookup.
  email?: string;
  githubLogin?: string;
  // Every memory VISIBLE ON THIS TURN — the current person's own, plus the ones
  // the owner promoted to global or into this channel/group. Titles only, so
  // kyto knows what durable knowledge exists and can fetch the full body when
  // relevant.
  memories?: {
    title: string;
    createdBy?: string;
    isGlobal?: boolean;
    scopeId?: string | null;
    scopeKind?: string | null;
  }[];
  ownerUserId?: string;
  threadId: string;
  workspace?: string;
}
