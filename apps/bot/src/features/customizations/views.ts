import { BYOK_PROVIDER_IDS, BYOK_PROVIDERS, personas } from '@repo/ai';
import type {
  ChatgptAccount,
  IdentityProfile,
  Reminder,
  SlackGrant,
  UserMcpServer,
  UserModelCredential,
} from '@repo/db/queries';
import { mrkdwn, plainText } from '@/harness';
import {
  formatMcpRules,
  formatToolOverrides,
  MCP_CATEGORIES,
  MCP_CATEGORY_LABELS,
  MCP_RULE_LABELS,
  MCP_RULES,
  type McpCategory,
  type McpRule,
  parseMcpRules,
} from '@/lib/ai/mcp-permissions';
import { IDENTITY_TYPES, type IdentityType } from '@/lib/identity';
import type { SlackBlock, SlackHomeView, SlackModalView } from '@/types/views';
import type { ErasePreview } from './erase';

const maxHomePromptLength = 600;
const maxPromptLength = 3000;
const REMINDER_TEXT_MAX = 120;
const MINUTES_PER_HOUR = 60;

const IDENTITY_LABELS: Record<IdentityType, string> = {
  normal: 'Replies & cross-channel posts',
  reminder: 'Reminder DMs',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeReminderSchedule(reminder: Reminder): string {
  if (reminder.recurrence === 'interval') {
    return `every ${reminder.intervalSeconds}s`;
  }
  const minutes = reminder.timeOfDayMinutes ?? 0;
  const time = `${String(Math.floor(minutes / MINUTES_PER_HOUR)).padStart(2, '0')}:${String(minutes % MINUTES_PER_HOUR).padStart(2, '0')} UTC`;
  if (reminder.recurrence === 'daily') {
    return `daily at ${time}`;
  }
  return `${WEEKDAYS[reminder.weekday ?? 0]} at ${time}`;
}

function escapeSlackText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const VALIDATION_BADGES: Record<string, string> = {
  invalid: ':x: invalid',
  unvalidated: ':grey_question: not checked yet',
  valid: ':white_check_mark: valid',
};

const VALIDATION_MESSAGE_MAX = 140;

// The Model keys (BYOK) section: the acting user's own provider keys, which
// their turns run on instead of kyto's shared models. Only ever rendered for the
// key's owner — the App Home tab is per-user, so no one else can see these.
function modelKeyBlocks(credentials: UserModelCredential[]): SlackBlock[] {
  const blocks: SlackBlock[] = [
    { type: 'divider' },
    {
      accessory: {
        action_id: 'home_add_model_key',
        text: plainText('Add key'),
        type: 'button',
      },
      text: mrkdwn(
        "*Model keys*\nBring your own key: your turns run on your provider and model instead of kyto's shared models. Keys are encrypted at rest and only ever used for your own turns."
      ),
      type: 'section',
    },
  ];
  if (credentials.length === 0) {
    blocks.push({
      elements: [mrkdwn("_No keys — you're on kyto's shared models._")],
      type: 'context',
    });
    return blocks;
  }
  for (const credential of credentials) {
    const label =
      BYOK_PROVIDERS[credential.provider as keyof typeof BYOK_PROVIDERS]
        ?.label ?? credential.provider;
    const badge =
      VALIDATION_BADGES[credential.validationStatus] ??
      VALIDATION_BADGES.unvalidated;
    blocks.push(
      {
        accessory: {
          action_id: 'home_remove_model_key',
          confirm: {
            confirm: plainText('Remove'),
            deny: plainText('Keep'),
            text: mrkdwn(`Your ${escapeSlackText(label)} key will be deleted.`),
            title: plainText('Remove key?'),
          },
          style: 'danger',
          text: plainText('Remove'),
          type: 'button',
          value: credential.provider,
        },
        text: mrkdwn(
          `*${escapeSlackText(label)}* — \`${escapeSlackText(credential.model)}\` · key ${escapeSlackText(credential.keyPreview)} · ${badge}`
        ),
        type: 'section',
      },
      {
        elements: [
          {
            action_id: 'home_edit_model_key',
            text: plainText('Edit / rotate'),
            type: 'button',
            value: credential.provider,
          },
          {
            action_id: 'home_toggle_model_key_fallback',
            text: plainText(
              credential.serviceFallback
                ? 'Shared fallback: on'
                : 'Shared fallback: off'
            ),
            type: 'button',
            // The target state, so a stale home view can't flip it the wrong way.
            value: `${credential.provider}:${credential.serviceFallback ? 'off' : 'on'}`,
          },
        ],
        type: 'actions',
      }
    );
    if (credential.validationStatus === 'invalid') {
      blocks.push({
        elements: [
          mrkdwn(
            `:warning: ${escapeSlackText(
              (
                credential.validationMessage ??
                'The provider rejected this key.'
              ).slice(0, VALIDATION_MESSAGE_MAX)
            )}`
          ),
        ],
        type: 'context',
      });
    }
  }
  blocks.push({
    elements: [
      mrkdwn(
        "_Shared fallback off means a failing key stops the turn — kyto won't quietly spend the shared budget for you._"
      ),
    ],
    type: 'context',
  });
  return blocks;
}

// The "Sign in with ChatGPT" section: link a ChatGPT account so the user's turns
// run on their own subscription. Gated on the same key as BYOK (both store
// encrypted secrets). Only ever rendered for the account owner (App Home is
// per-user).
const CHATGPT_DEFAULT_MODEL = 'gpt-5';

function chatgptBlocks(account: ChatgptAccount | null): SlackBlock[] {
  if (!account) {
    return [
      { type: 'divider' },
      {
        accessory: {
          action_id: 'home_link_chatgpt',
          style: 'primary',
          text: plainText('Sign in with ChatGPT'),
          type: 'button',
        },
        text: mrkdwn(
          "*Sign in with ChatGPT*\nLink your ChatGPT account (Plus / Pro / Team) and your turns run on your own subscription instead of kyto's shared models."
        ),
        type: 'section',
      },
      {
        elements: [mrkdwn('_Not linked._')],
        type: 'context',
      },
    ];
  }
  const badge =
    VALIDATION_BADGES[account.validationStatus] ??
    VALIDATION_BADGES.unvalidated;
  const blocks: SlackBlock[] = [
    { type: 'divider' },
    {
      accessory: {
        action_id: 'home_unlink_chatgpt',
        confirm: {
          confirm: plainText('Unlink'),
          deny: plainText('Keep'),
          text: mrkdwn('Your ChatGPT account will be disconnected.'),
          title: plainText('Unlink ChatGPT?'),
        },
        style: 'danger',
        text: plainText('Unlink'),
        type: 'button',
      },
      text: mrkdwn(
        `*ChatGPT* — ${escapeSlackText(account.accountLabel)} · \`${escapeSlackText(account.model)}\` · ${badge}`
      ),
      type: 'section',
    },
    {
      elements: [
        {
          action_id: 'home_edit_chatgpt_model',
          text: plainText('Change model'),
          type: 'button',
        },
        {
          action_id: 'home_toggle_chatgpt_first',
          text: plainText(
            account.chatgptFirst
              ? 'Order: ChatGPT first'
              : 'Order: shared first'
          ),
          type: 'button',
          // The target state, so a stale home view can't flip it the wrong way.
          value: account.chatgptFirst ? 'off' : 'on',
        },
      ],
      type: 'actions',
    },
  ];
  if (account.validationStatus === 'invalid') {
    blocks.push({
      elements: [
        mrkdwn(
          `:warning: ${escapeSlackText(
            (
              account.validationMessage ?? 'Your ChatGPT login needs attention.'
            ).slice(0, VALIDATION_MESSAGE_MAX)
          )}`
        ),
      ],
      type: 'context',
    });
  }
  blocks.push({
    elements: [
      mrkdwn(
        '_“ChatGPT first” runs your subscription first and falls back to kyto’s shared models; “shared first” uses the shared models first and only falls back to ChatGPT. Tap to switch._'
      ),
    ],
    type: 'context',
  });
  return blocks;
}

/**
 * The "Sign in with ChatGPT" modal. `authUrl` is the pre-generated authorize
 * link (the PKCE verifier for it is held server-side, keyed by the user). The
 * user opens it, signs in, and pastes the URL they land on back here.
 */
export function buildChatgptLinkModal(authUrl: string): SlackModalView {
  return {
    blocks: [
      {
        text: mrkdwn(
          `*1.* <${authUrl}|Open the ChatGPT sign-in page> and log in.\n*2.* Your browser will try to open a \`localhost:1455\` page that won't load — that's expected.\n*3.* Copy the full URL from your browser's address bar and paste it below.`
        ),
        type: 'section',
      },
      {
        block_id: 'chatgpt_callback',
        element: {
          action_id: 'callback',
          multiline: true,
          placeholder: plainText('http://localhost:1455/auth/callback?code=…'),
          type: 'plain_text_input',
        },
        hint: plainText(
          'The full URL you were redirected to (or just the code).'
        ),
        label: plainText('Redirected URL'),
        type: 'input',
      },
      {
        block_id: 'chatgpt_model',
        element: {
          action_id: 'model',
          initial_value: CHATGPT_DEFAULT_MODEL,
          max_length: 120,
          placeholder: plainText('e.g. gpt-5'),
          type: 'plain_text_input',
        },
        hint: plainText(
          'The model to run for your turns. Change it later from App Home.'
        ),
        label: plainText('Model'),
        type: 'input',
      },
    ],
    callback_id: 'home_save_chatgpt',
    close: plainText('Cancel'),
    submit: plainText('Link account'),
    title: plainText('Sign in with ChatGPT'),
    type: 'modal',
  };
}

// Slack caps a static_select at 100 options.
const CHATGPT_MODEL_OPTIONS_MAX = 100;

/**
 * Change the model a linked ChatGPT account runs on. When the account's
 * available models were fetched (`models`), render a dropdown of exactly those;
 * otherwise fall back to a free-text field (the fetch can fail, and the user can
 * still type a valid id).
 */
export function buildChatgptModelModal(
  account: ChatgptAccount,
  models: string[] = []
): SlackModalView {
  const usable = models.slice(0, CHATGPT_MODEL_OPTIONS_MAX);
  const options = usable.map((id) => ({ text: plainText(id), value: id }));
  const initial = options.find((option) => option.value === account.model);
  const modelBlock: SlackBlock =
    usable.length > 0
      ? {
          block_id: 'chatgpt_model',
          element: {
            action_id: 'model',
            ...(initial ? { initial_option: initial } : {}),
            options,
            placeholder: plainText('Choose a model'),
            type: 'static_select',
          },
          hint: plainText('The models available to your ChatGPT account.'),
          label: plainText('Model'),
          type: 'input',
        }
      : {
          block_id: 'chatgpt_model',
          element: {
            action_id: 'model',
            initial_value: account.model,
            max_length: 120,
            placeholder: plainText('e.g. gpt-5'),
            type: 'plain_text_input',
          },
          hint: plainText('The model kyto runs on your ChatGPT subscription.'),
          label: plainText('Model'),
          type: 'input',
        };
  return {
    blocks: [modelBlock],
    callback_id: 'home_save_chatgpt_model',
    close: plainText('Cancel'),
    submit: plainText('Save'),
    title: plainText('ChatGPT model'),
    type: 'modal',
  };
}

/**
 * "Your Slack account" — the per-user OAuth grant (`lib/slack-oauth`).
 *
 * Deliberately says what it is FOR before asking: this is a person handing kyto
 * the ability to act as them, so the section names the one thing that needs it
 * today (`!secret`) rather than a vague "connect for more features".
 */
function slackGrantBlocks(grant: SlackGrant | null): SlackBlock[] {
  if (!grant) {
    return [
      { type: 'divider' },
      {
        accessory: {
          action_id: 'home_connect_slack',
          style: 'primary',
          text: plainText('Connect'),
          type: 'button',
        },
        text: mrkdwn(
          '*Your Slack account*\nConnect your own Slack account so kyto can act as you where you ask it to. Needed for `!secret` — asking privately works by kyto deleting your question, and only your own account can delete your messages. The token is encrypted at rest and never used except for something you asked for.'
        ),
        type: 'section',
      },
      { elements: [mrkdwn('_Not connected._')], type: 'context' },
    ];
  }
  return [
    { type: 'divider' },
    {
      accessory: {
        action_id: 'home_disconnect_slack',
        confirm: {
          confirm: plainText('Disconnect'),
          deny: plainText('Keep'),
          text: mrkdwn(
            'kyto will no longer be able to act as you, and `!secret` will stop working until you reconnect.'
          ),
          title: plainText('Disconnect Slack?'),
        },
        style: 'danger',
        text: plainText('Disconnect'),
        type: 'button',
      },
      text: mrkdwn(
        '*Your Slack account*\nConnected — kyto can act as you where you ask it to.'
      ),
      type: 'section',
    },
    {
      elements: [mrkdwn(`_Granted: ${escapeSlackText(grant.scopes)}_`)],
      type: 'context',
    },
  ];
}

export function buildHomeView({
  byokEnabled = false,
  chatgptAccount = null,
  identityProfiles = [],
  isOwner = false,
  mcpFailures = {},
  mcpServers = [],
  modelCredentials = [],
  privacy,
  prompt,
  reminders = [],
  showUsageFooter = true,
  slackGrant = null,
  slackOauthEnabled = false,
  userId,
}: {
  /** False when the host has no BYOK_ENCRYPTION_KEY: hide the section entirely. */
  byokEnabled?: boolean;
  /** What an erase would remove, so the section can be specific about it. */
  privacy?: ErasePreview;
  /** The user's linked ChatGPT account, or null. Rendered under the BYOK gate. */
  chatgptAccount?: ChatgptAccount | null;
  identityProfiles?: IdentityProfile[];
  isOwner?: boolean;
  /** Server name → why its last listing failed, so a dead entry says so. */
  mcpFailures?: Record<string, string>;
  mcpServers?: UserMcpServer[];
  modelCredentials?: UserModelCredential[];
  prompt: string | null;
  reminders?: Reminder[];
  showUsageFooter?: boolean;
  /** The user's own Slack authorization, or null. */
  slackGrant?: SlackGrant | null;
  /** False when the host has no Slack app OAuth credentials: hide the section. */
  slackOauthEnabled?: boolean;
  /** The person viewing the tab, to mark reminders someone else shared here. */
  userId: string;
}): SlackHomeView {
  const displayedPrompt = prompt
    ? escapeSlackText(
        prompt.length > maxHomePromptLength
          ? `${prompt.slice(0, maxHomePromptLength)}...`
          : prompt
      )
    : '_No custom instructions set._';

  const blocks: SlackBlock[] = [
    { text: plainText('Kyto'), type: 'header' },
    {
      elements: [
        mrkdwn('Customize how Kyto behaves across your Slack conversations.'),
      ],
      type: 'context',
    },
    { type: 'divider' },
    {
      accessory: {
        action_id: 'home_edit_prompt',
        text: plainText(prompt ? 'Edit' : 'Add'),
        type: 'button',
      },
      text: mrkdwn(`*Custom Instructions*\n${displayedPrompt}`),
      type: 'section',
    },
  ];

  if (prompt) {
    blocks.push({
      elements: [
        {
          action_id: 'home_clear_prompt',
          confirm: {
            confirm: plainText('Clear'),
            deny: plainText('Keep'),
            text: mrkdwn('Your custom instructions will be removed.'),
            title: plainText('Clear instructions?'),
          },
          style: 'danger',
          text: plainText('Clear instructions'),
          type: 'button',
        },
      ],
      type: 'actions',
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      accessory: {
        action_id: 'home_toggle_footer',
        text: plainText(showUsageFooter ? 'Disable' : 'Enable'),
        type: 'button',
        value: showUsageFooter ? 'off' : 'on',
      },
      text: mrkdwn(
        `*Usage footer*\nShow a small token count · tokens/sec line under Kyto's replies. Currently *${showUsageFooter ? 'on' : 'off'}*.`
      ),
      type: 'section',
    }
  );

  if (byokEnabled) {
    blocks.push(...chatgptBlocks(chatgptAccount));
  }
  if (slackOauthEnabled) {
    blocks.push(...slackGrantBlocks(slackGrant));
    blocks.push(...modelKeyBlocks(modelCredentials));
  }

  blocks.push(
    { type: 'divider' },
    {
      accessory: {
        action_id: 'home_add_mcp',
        text: plainText('Add server'),
        type: 'button',
      },
      text: mrkdwn(
        '*MCP servers*\nConnect remote MCP servers (HTTP); their tools become available on your turns.'
      ),
      type: 'section',
    }
  );
  for (const server of mcpServers) {
    const failure = mcpFailures[server.name];
    const rules = parseMcpRules(server.rules);
    blocks.push(
      {
        text: mrkdwn(
          `\`${escapeSlackText(server.name)}\` — ${escapeSlackText(server.url)}${
            server.authorization ? ' · :key: token saved' : ''
          }\n_${escapeSlackText(formatMcpRules(rules))}_${
            failure
              ? `\n:warning: no tools loaded — ${escapeSlackText(failure)}`
              : ''
          }`
        ),
        type: 'section',
      },
      {
        elements: [
          {
            action_id: 'home_edit_mcp',
            text: plainText('Edit'),
            type: 'button',
            value: server.name,
          },
          {
            action_id: 'home_remove_mcp',
            confirm: {
              confirm: plainText('Remove'),
              deny: plainText('Keep'),
              text: mrkdwn(
                `\`${escapeSlackText(server.name)}\` will be removed.`
              ),
              title: plainText('Remove MCP server?'),
            },
            style: 'danger',
            text: plainText('Remove'),
            type: 'button',
            value: server.name,
          },
        ],
        type: 'actions',
      }
    );
  }

  // Recurring reminders: list + pause/resume/cancel (per user).
  blocks.push(
    { type: 'divider' },
    {
      text: mrkdwn(
        '*Reminders*\nRecurring reminders you created, plus any you were named an editor of. Create them by asking Kyto; manage them here.'
      ),
      type: 'section',
    }
  );
  if (reminders.length === 0) {
    blocks.push({
      elements: [mrkdwn('_No recurring reminders._')],
      type: 'context',
    });
  }
  for (const reminder of reminders) {
    const text =
      reminder.text.length > REMINDER_TEXT_MAX
        ? `${reminder.text.slice(0, REMINDER_TEXT_MAX)}…`
        : reminder.text;
    const target = reminder.channelId ? `<#${reminder.channelId}>` : 'DM';
    const state = reminder.active ? 'active' : 'paused';
    const creator =
      reminder.userId === userId ? '' : ` · by <@${reminder.userId}>`;
    blocks.push(
      {
        text: mrkdwn(
          `“${escapeSlackText(text)}”\n${reminder.kind} · ${describeReminderSchedule(reminder)} · ${target} · *${state}*${creator}`
        ),
        type: 'section',
      },
      {
        elements: [
          {
            action_id: reminder.active
              ? 'home_pause_reminder'
              : 'home_resume_reminder',
            text: plainText(reminder.active ? 'Pause' : 'Resume'),
            type: 'button',
            value: reminder.id,
          },
          {
            action_id: 'home_cancel_reminder',
            confirm: {
              confirm: plainText('Delete'),
              deny: plainText('Keep'),
              text: mrkdwn('This reminder will be deleted.'),
              title: plainText('Delete reminder?'),
            },
            style: 'danger',
            text: plainText('Delete'),
            type: 'button',
            value: reminder.id,
          },
        ],
        type: 'actions',
      }
    );
  }

  blocks.push(...privacyBlocks(privacy));

  // Owner-only: how kyto presents itself per message type (name suffix + icon).
  if (isOwner) {
    blocks.push(
      { type: 'divider' },
      {
        accessory: {
          action_id: 'home_edit_identity',
          text: plainText('Edit'),
          type: 'button',
        },
        text: mrkdwn(
          '*Identity*\nSet an icon per message type. The name is always plain “kyto” — only the avatar changes.'
        ),
        type: 'section',
      }
    );
    const byType = new Map(identityProfiles.map((p) => [p.messageType, p]));
    for (const type of IDENTITY_TYPES) {
      const profile = byType.get(type);
      const icon = profile?.icon?.trim();
      const summary = icon ? `icon: ${escapeSlackText(icon)}` : '_default_';
      blocks.push({
        elements: [mrkdwn(`*${IDENTITY_LABELS[type]}* — ${summary}`)],
        type: 'context',
      });
    }
  }

  return { blocks, type: 'home' };
}

/**
 * "Your data" — what kyto has kept that came out of your conversations, and the
 * self-serve way to remove it. Everyone gets this section; the whole point is
 * that withdrawing consent should not require asking the bot owner.
 *
 * Two buttons rather than one because they are genuinely different asks: forget
 * what you TOLD it, versus also delete what you CONFIGURED (your API keys, your
 * MCP servers). Someone withdrawing consent to data retention usually does not
 * mean "and throw away my keys".
 */
function privacyBlocks(privacy: ErasePreview | undefined): SlackBlock[] {
  const counts = privacy
    ? [
        `${privacy.privateMemories} saved ${privacy.privateMemories === 1 ? 'memory' : 'memories'}`,
        privacy.promotedMemories > 0
          ? `${privacy.promotedMemories} promoted workspace-wide`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'memories and a short-lived reasoning cache';
  const blocks: SlackBlock[] = [
    { type: 'divider' },
    {
      text: mrkdwn(
        `*Your data*\nKyto stores two things derived from your conversations: memories it saved, and a cache of its own reasoning from your last few turns (kept about 30 days). It never stores a copy of your messages — it reads the Slack thread each turn. Currently: ${counts}.`
      ),
      type: 'section',
    },
    {
      elements: [
        {
          action_id: 'home_forget_me',
          confirm: {
            confirm: plainText('Forget me'),
            deny: plainText('Cancel'),
            text: mrkdwn(
              "Kyto will delete the memories you saved and its stored reasoning from your DM threads with it, and destroy your DM threads' sandbox workspaces. Your settings and API keys are kept. This cannot be undone."
            ),
            title: plainText('Forget what you told Kyto?'),
          },
          style: 'danger',
          text: plainText('Forget me'),
          type: 'button',
        },
        {
          action_id: 'home_erase_everything',
          confirm: {
            confirm: plainText('Delete everything'),
            deny: plainText('Cancel'),
            text: mrkdwn(
              'Everything above, PLUS your custom instructions, MCP servers, saved model keys and any linked ChatGPT account. Reminders and hosted sites are left alone — delete those individually above. This cannot be undone.'
            ),
            title: plainText('Delete all your Kyto data?'),
          },
          style: 'danger',
          text: plainText('Delete everything'),
          type: 'button',
        },
      ],
      type: 'actions',
    },
  ];
  if (privacy && privacy.promotedMemories > 0) {
    blocks.push({
      elements: [
        mrkdwn(
          `_${privacy.promotedMemories} of your memories were promoted to workspace-wide. Promotion hands custody to the bot owner, so only they can remove those — you'll be told which ones._`
        ),
      ],
      type: 'context',
    });
  }
  return blocks;
}

export function buildIdentityModal(
  profiles: IdentityProfile[]
): SlackModalView {
  const byType = new Map(profiles.map((p) => [p.messageType, p]));
  const blocks: SlackBlock[] = [];
  for (const type of IDENTITY_TYPES) {
    const profile = byType.get(type);
    blocks.push(
      { text: mrkdwn(`*${IDENTITY_LABELS[type]}*`), type: 'section' },
      {
        block_id: `identity_${type}_icon`,
        element: {
          action_id: 'icon',
          ...(profile?.icon ? { initial_value: profile.icon } : {}),
          max_length: 300,
          placeholder: plainText(':robot_face: or https://…/pic.png'),
          type: 'plain_text_input',
        },
        hint: plainText(
          'A :emoji: code or an image URL. Leave blank for none.'
        ),
        label: plainText('Icon'),
        optional: true,
        type: 'input',
      },
      { type: 'divider' }
    );
  }
  return {
    blocks,
    callback_id: 'home_save_identity',
    close: plainText('Cancel'),
    submit: plainText('Save'),
    title: plainText('Kyto identity'),
    type: 'modal',
  };
}

const KEY_INPUT_MAX = 400;

/**
 * Add or rotate one BYOK key. On edit the key field is optional: leaving it
 * blank keeps the stored key and only updates the model/base URL, so changing a
 * model doesn't force the user to paste their secret again.
 *
 * `private_metadata` carries ONLY the provider slug. Never put key material in
 * it — Slack echoes it back into the view payload.
 */
export function buildModelKeyModal(
  credential?: UserModelCredential
): SlackModalView {
  const editing = Boolean(credential);
  const options = BYOK_PROVIDER_IDS.map((id) => ({
    text: plainText(BYOK_PROVIDERS[id].label),
    value: id,
  }));
  const initialProvider = credential
    ? options.find((option) => option.value === credential.provider)
    : undefined;
  return {
    blocks: [
      {
        block_id: 'byok_provider',
        element: {
          action_id: 'provider',
          ...(initialProvider ? { initial_option: initialProvider } : {}),
          options,
          placeholder: plainText('Choose a provider'),
          type: 'static_select',
        },
        hint: plainText(
          'Any OpenAI-compatible provider. Pick Custom to supply your own base URL.'
        ),
        label: plainText('Provider'),
        type: 'input',
      },
      {
        block_id: 'byok_model',
        element: {
          action_id: 'model',
          ...(credential ? { initial_value: credential.model } : {}),
          max_length: 120,
          placeholder: plainText('e.g. gpt-5.5'),
          type: 'plain_text_input',
        },
        hint: plainText('The model id kyto should run for your turns.'),
        label: plainText('Model'),
        type: 'input',
      },
      {
        block_id: 'byok_key',
        element: {
          action_id: 'key',
          max_length: KEY_INPUT_MAX,
          placeholder: plainText(editing ? 'Leave blank to keep' : 'sk-…'),
          type: 'plain_text_input',
        },
        hint: plainText(
          editing
            ? 'Paste a new key to rotate it, or leave blank to keep the current one.'
            : 'Encrypted at rest. Only ever used for your own turns; never shown back to you or put in a prompt.'
        ),
        label: plainText('API key'),
        optional: editing,
        type: 'input',
      },
      {
        block_id: 'byok_base_url',
        element: {
          action_id: 'base_url',
          ...(credential?.baseUrl ? { initial_value: credential.baseUrl } : {}),
          placeholder: plainText('https://…/v1'),
          type: 'plain_text_input',
        },
        hint: plainText(
          'Optional. Required for Custom; otherwise only to point at a proxy.'
        ),
        label: plainText('Base URL'),
        optional: true,
        type: 'input',
      },
    ],
    callback_id: 'home_save_model_key',
    close: plainText('Cancel'),
    ...(credential
      ? { private_metadata: JSON.stringify({ provider: credential.provider }) }
      : {}),
    submit: plainText('Save'),
    title: plainText(editing ? 'Edit model key' : 'Add model key'),
    type: 'modal',
  };
}

export function buildMcpModal({
  server,
}: {
  server?: UserMcpServer | null;
} = {}): SlackModalView {
  const editing = Boolean(server);
  const rules = parseMcpRules(server?.rules);
  const blocks: SlackBlock[] = [];
  if (server) {
    blocks.push({
      elements: [mrkdwn(`Editing \`${escapeSlackText(server.name)}\`.`)],
      type: 'context',
    });
  } else {
    blocks.push({
      block_id: 'mcp_name',
      element: {
        action_id: 'name',
        max_length: 32,
        placeholder: plainText('e.g. github'),
        type: 'plain_text_input',
      },
      hint: plainText('Short handle used to namespace the tools.'),
      label: plainText('Name'),
      type: 'input',
    });
  }
  blocks.push({
    block_id: 'mcp_url',
    element: {
      action_id: 'url',
      ...(server ? { initial_value: server.url } : {}),
      placeholder: plainText('https://example.com/mcp'),
      type: 'plain_text_input',
    },
    hint: plainText(
      'Streamable HTTP endpoint. Servers on your own machine are not reachable from Slack.'
    ),
    label: plainText('Server URL'),
    type: 'input',
  });
  blocks.push({
    block_id: 'mcp_authorization',
    element: {
      action_id: 'authorization',
      placeholder: plainText('paste your API token'),
      type: 'plain_text_input',
    },
    // The stored token is never rendered back, so a blank field on an edit has to
    // mean "keep it" — otherwise opening the modal to change one rule would wipe
    // the credential. Clearing is the separate control below.
    hint: plainText(tokenHint(server)),
    label: plainText(editing ? 'Replace API token' : 'Authorization'),
    optional: true,
    type: 'input',
  });
  if (server?.authorization) {
    blocks.push({
      block_id: 'mcp_token_action',
      element: {
        action_id: 'token_action',
        initial_option: tokenActionOption('keep'),
        options: [tokenActionOption('keep'), tokenActionOption('clear')],
        type: 'static_select',
      },
      label: plainText('Saved token'),
      type: 'input',
    });
  }
  blocks.push(
    { type: 'divider' },
    {
      elements: [
        mrkdwn(
          "*Permissions.* Kyto sorts each of the server's tools by what it does. Reads run freely; anything that can leak or change something asks you first, in the thread. *Never* hides those tools from Kyto entirely, so they cannot be reached at all."
        ),
      ],
      type: 'context',
    },
    ...MCP_CATEGORIES.map((category) => ruleSelect(category, rules[category])),
    {
      block_id: 'mcp_tool_rules',
      element: {
        action_id: 'tool_rules',
        ...(editing
          ? { initial_value: formatToolOverrides(rules) || undefined }
          : {}),
        multiline: true,
        placeholder: plainText('get_logs: never\ndeploy: ask'),
        type: 'plain_text_input',
      },
      hint: plainText(
        'One per line, "tool_name: allow | ask | never". Overrides the category above for that one tool. Use the server\'s own tool name.'
      ),
      label: plainText('Per-tool exceptions'),
      optional: true,
      type: 'input',
    }
  );
  return {
    blocks,
    callback_id: editing ? 'home_edit_mcp_server' : 'home_add_mcp_server',
    close: plainText('Cancel'),
    ...(server
      ? { private_metadata: JSON.stringify({ name: server.name }) }
      : {}),
    submit: plainText(editing ? 'Save' : 'Add'),
    title: plainText(editing ? 'Edit MCP server' : 'Add MCP server'),
    type: 'modal',
  };
}

function tokenHint(server?: UserMcpServer | null): string {
  if (!server) {
    return 'Optional. A bare token becomes "Bearer <token>"; write the scheme yourself for anything else (e.g. "Basic …").';
  }
  return server.authorization
    ? 'A token is saved. Leave blank to keep it, or paste a new one to replace it.'
    : 'No token saved. Paste one to add it.';
}

function tokenActionOption(action: 'clear' | 'keep') {
  return {
    text: plainText(
      action === 'keep' ? 'Keep the saved token' : 'Remove the saved token'
    ),
    value: action,
  };
}

function ruleSelect(category: McpCategory, rule: McpRule): SlackBlock {
  const option = (value: McpRule) => ({
    text: plainText(MCP_RULE_LABELS[value]),
    value,
  });
  return {
    block_id: `mcp_rule_${category}`,
    element: {
      action_id: `rule_${category}`,
      initial_option: option(rule),
      options: MCP_RULES.map(option),
      type: 'static_select',
    },
    label: plainText(MCP_CATEGORY_LABELS[category]),
    type: 'input',
  };
}

export function buildPromptModal({
  prompt,
  showPresets = false,
}: {
  prompt: string | null;
  showPresets?: boolean;
}): SlackModalView {
  const presetBlocks: SlackBlock[] = showPresets
    ? personas.map((persona) => ({
        accessory: {
          action_id: 'modal_load_preset',
          text: plainText('Load'),
          type: 'button',
          value: persona.id,
        },
        text: mrkdwn(
          `*${escapeSlackText(persona.name)}:* ${escapeSlackText(persona.description)}`
        ),
        type: 'section',
      }))
    : [];

  return {
    blocks: [
      {
        accessory: {
          action_id: 'modal_toggle_presets',
          text: plainText(showPresets ? 'Close' : 'Open'),
          type: 'button',
        },
        text: mrkdwn(showPresets ? '*Presets*' : '*Presets*: load a persona'),
        type: 'section',
      },
      ...presetBlocks,
      { type: 'divider' },
      {
        block_id: 'customization_prompt',
        element: {
          action_id: 'prompt',
          ...(prompt ? { initial_value: prompt } : {}),
          max_length: maxPromptLength,
          multiline: true,
          placeholder: plainText(
            'e.g. Keep responses concise. Prefer TypeScript. Call me Alex.'
          ),
          type: 'plain_text_input',
        },
        hint: plainText(
          'Kyto follows these instructions across every conversation.'
        ),
        label: plainText('Your instructions'),
        type: 'input',
      },
    ],
    callback_id: 'home_save_prompt',
    close: plainText('Cancel'),
    private_metadata: JSON.stringify({ showPresets }),
    submit: plainText('Save'),
    title: plainText('Custom Instructions'),
    type: 'modal',
  };
}

export function buildPresetModal({
  description,
  name,
  prompt,
}: {
  description: string;
  name: string;
  prompt: string;
}): SlackModalView {
  return {
    blocks: [
      {
        elements: [mrkdwn(escapeSlackText(description))],
        type: 'context',
      },
      {
        block_id: 'customization_prompt',
        element: {
          action_id: 'prompt',
          initial_value: prompt,
          max_length: maxPromptLength,
          multiline: true,
          type: 'plain_text_input',
        },
        hint: plainText('You can edit this before saving.'),
        label: plainText('Preset instructions'),
        type: 'input',
      },
    ],
    callback_id: 'home_save_preset_prompt',
    close: plainText('Back'),
    submit: plainText('Use this preset'),
    title: plainText(name),
    type: 'modal',
  };
}
