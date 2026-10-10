import { z } from 'zod';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Slack's code channel API (`agents.conversations.*`, `agents.sessions.*`).
// Only a code channel's AGENT manages it — kyto's app, for the channels it
// creates and the ones people start with it from Slack's own UI — which needs
// the app's `code_channels:manage` scope and `features.code_channels`. The
// Slack SDK in use has no typed methods for these, so they go through apiCall.

const responseSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean().optional(),
  response_metadata: z
    .looseObject({ messages: z.array(z.string()).optional() })
    .optional(),
});
type AgentsResponse = z.infer<typeof responseSchema>;

// apiCall throws on `ok: false`, carrying Slack's body as `data`.
const platformErrorSchema = z.looseObject({ data: responseSchema });

/** Never throws: Slack's response, or `{ ok: false, error }`. */
export async function callAgents({
  method,
  params,
}: {
  method: string;
  params: Record<string, unknown>;
}): Promise<AgentsResponse> {
  try {
    return responseSchema.parse(await slack.webClient.apiCall(method, params));
  } catch (error) {
    const refused = platformErrorSchema.safeParse(error);
    if (refused.success) {
      return { ...refused.data.data, ok: false };
    }
    logger.warn({ err: errorMessage(error), method }, '[code-channel] failed');
    return { error: errorMessage(error), ok: false };
  }
}

const ERROR_HELP: Record<string, string> = {
  feature_disabled:
    "Slack hasn't enabled code channels for kyto's app in this workspace.",
  missing_scope:
    "kyto's Slack app doesn't have the code_channels:manage scope yet — the bot owner has to reinstall the app after the manifest change.",
  not_allowed:
    "kyto isn't this code channel's agent, so Slack won't let it manage it.",
  restricted_action:
    "this workspace doesn't let that person create this kind of channel.",
  user_not_enabled: "Slack's code channels aren't enabled for that person.",
};

/** A refused call, as words for the model or a person. */
export function refusalText(response: AgentsResponse): string {
  const error = response.error ?? 'unknown_error';
  const detail = response.response_metadata?.messages ?? [];
  return [
    `Slack refused it (${error})`,
    ERROR_HELP[error],
    detail.length > 0 ? detail.join('; ') : undefined,
  ]
    .filter(Boolean)
    .join(': ');
}

/**
 * Slack's working indicator for the channel's session: `processing` while a
 * turn runs, `active` after. Best-effort — a failure costs the indicator only.
 */
export async function setSessionStatus({
  channel,
  status,
}: {
  channel: string;
  status: 'active' | 'processing' | 'suspended';
}): Promise<void> {
  const response = await callAgents({
    method: 'agents.sessions.setStatus',
    params: { channel_id: channel, status },
  });
  if (!response.ok) {
    logger.warn(
      { channel, error: response.error, status },
      '[code-channel] could not set the session status'
    );
  }
}

const infoSchema = z.looseObject({
  channel: z
    .looseObject({
      properties: z
        .looseObject({
          record_channel: z
            .looseObject({ record_type: z.string().optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

const agentOf = new Map<string, Promise<boolean>>();

/**
 * Whether `channel` is a Slack code channel whose agent is kyto's app — one
 * someone started with kyto from Slack's own UI. Its record names its agent;
 * a code channel of ANOTHER agent must stay an ordinary channel to kyto, or
 * kyto would answer every message in someone else's session. A channel's kind
 * never changes, so the answer is kept for the process's life.
 */
export function kytoIsAgentOf(channel: string): Promise<boolean> {
  const known = agentOf.get(channel);
  if (known) {
    return known;
  }
  const lookup = slack.webClient.conversations
    .info({ channel })
    .then((raw) => {
      const record = infoSchema.parse(raw).channel?.properties?.record_channel;
      if (record?.record_type !== 'agent_channel') {
        return false;
      }
      const text = JSON.stringify(record);
      const ours = [slack.botUserId, slack.botId].some(
        (id) => id !== undefined && text.includes(id)
      );
      logger.info(
        { channel, ours, record },
        '[code-channel] found a code channel'
      );
      return ours;
    })
    .catch((error: unknown) => {
      agentOf.delete(channel);
      logger.warn(
        { channel, err: errorMessage(error) },
        '[code-channel] could not read the channel'
      );
      return false;
    });
  agentOf.set(channel, lookup);
  return lookup;
}
