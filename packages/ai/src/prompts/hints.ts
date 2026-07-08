export interface RequestHints {
  botUserId?: string;
  channel?: {
    id?: string;
    name?: string;
  };
  customization?: { prompt: string; showUsageFooter?: boolean } | null;
  messageId?: string;
  ownerUserId?: string;
  threadId: string;
  time: string;
  workspace?: string;
}
