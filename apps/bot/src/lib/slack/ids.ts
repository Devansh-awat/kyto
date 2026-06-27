// Chat SDK Slack ids are `slack:CHANNEL` or `slack:CHANNEL:TS`. These convert to
// the raw Slack channel id (C123…) the Web API expects, and back.

// Slack channel ids start with C (public), G (private/group) or D (DM).
const RAW_SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]+$/;
// Slack renders a channel mention as `<#C123ABC|name>`; users/models often paste
// that, or a bare `#C123ABC`, when they mean a channel.
const SLACK_CHANNEL_MENTION = /^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/;

export function toRawSlackChannelId(id: string): string {
  return id.startsWith('slack:') ? (id.split(':')[1] ?? id) : id;
}

// Normalize the many shapes a channel reference arrives in (a Chat SDK id, a raw
// `C123` id, a `<#C123|name>` mention, or a bare `#C123`) into a Chat SDK
// `slack:CHANNEL` id. Throws only when the value can't be a Slack channel at all.
export function toChatSlackChannelId(channelId: string): string {
  const trimmed = channelId.trim();

  if (trimmed.startsWith('slack:') && trimmed.split(':').length === 2) {
    return trimmed;
  }

  const mention = trimmed.match(SLACK_CHANNEL_MENTION);
  if (mention) {
    return `slack:${mention[1]}`;
  }

  const raw = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (RAW_SLACK_CHANNEL_ID.test(raw)) {
    return `slack:${raw}`;
  }

  throw new Error(
    `${channelId} is not a Slack channel id. Use a value like C123456 or slack:C123456.`
  );
}
