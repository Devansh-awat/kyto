export interface RequestHints {
  botUserId?: string;
  channel?: {
    id?: string;
    name?: string;
  };
  customization?: { prompt: string } | null;
  messageId?: string;
  // Slack user id of kyto's actual owner/developer (env OWNER_USER_ID). Lets
  // the model correctly acknowledge this person as its creator instead of
  // confabulating a vague "a team of engineers" answer and disputing the
  // truth when they say so themselves.
  ownerUserId?: string;
  threadId: string;
  time: string;
  workspace?: string;
}
