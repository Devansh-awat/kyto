import { personas } from '@repo/ai';
import type { IdentityProfile, UserMcpServer } from '@repo/db/queries';
import { mrkdwn, plainText } from '@/harness';
import { IDENTITY_TYPES, type IdentityType } from '@/lib/identity';
import type { SlackBlock, SlackHomeView, SlackModalView } from '@/types/views';

const maxHomePromptLength = 600;
const maxPromptLength = 3000;

const IDENTITY_LABELS: Record<IdentityType, string> = {
  normal: 'Cross-channel posts',
  reminder: 'Reminder DMs',
  subagent: 'Subagent block',
};

function escapeSlackText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildHomeView({
  identityProfiles = [],
  isOwner = false,
  mcpServers = [],
  prompt,
  showUsageFooter = true,
}: {
  identityProfiles?: IdentityProfile[];
  isOwner?: boolean;
  mcpServers?: UserMcpServer[];
  prompt: string | null;
  showUsageFooter?: boolean;
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
    blocks.push({
      accessory: {
        action_id: 'home_remove_mcp',
        confirm: {
          confirm: plainText('Remove'),
          deny: plainText('Keep'),
          text: mrkdwn(`\`${escapeSlackText(server.name)}\` will be removed.`),
          title: plainText('Remove MCP server?'),
        },
        style: 'danger',
        text: plainText('Remove'),
        type: 'button',
        value: server.name,
      },
      text: mrkdwn(
        `\`${escapeSlackText(server.name)}\` — ${escapeSlackText(server.url)}`
      ),
      type: 'section',
    });
  }

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
          "*Identity*\nAdd a name suffix and icon per message type. The base name is always “kyto”; you're only adding a suffix."
        ),
        type: 'section',
      }
    );
    const byType = new Map(identityProfiles.map((p) => [p.messageType, p]));
    for (const type of IDENTITY_TYPES) {
      const profile = byType.get(type);
      const suffix = profile?.nameSuffix?.trim();
      const icon = profile?.icon?.trim();
      const summary =
        suffix || icon
          ? [
              suffix ? `name: kyto ${escapeSlackText(suffix)}` : null,
              icon ? `icon: ${escapeSlackText(icon)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : '_default_';
      blocks.push({
        elements: [mrkdwn(`*${IDENTITY_LABELS[type]}* — ${summary}`)],
        type: 'context',
      });
    }
  }

  return { blocks, type: 'home' };
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
        block_id: `identity_${type}_suffix`,
        element: {
          action_id: 'suffix',
          ...(profile?.nameSuffix ? { initial_value: profile.nameSuffix } : {}),
          max_length: 40,
          placeholder: plainText('e.g. subagent'),
          type: 'plain_text_input',
        },
        hint: plainText('Appended after “kyto ”. Leave blank for none.'),
        label: plainText('Name suffix'),
        optional: true,
        type: 'input',
      },
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

export function buildMcpModal(): SlackModalView {
  return {
    blocks: [
      {
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
      },
      {
        block_id: 'mcp_url',
        element: {
          action_id: 'url',
          placeholder: plainText('https://example.com/mcp'),
          type: 'plain_text_input',
        },
        hint: plainText(
          'Streamable HTTP endpoint. Servers on your own machine are not reachable from Slack.'
        ),
        label: plainText('Server URL'),
        type: 'input',
      },
      {
        block_id: 'mcp_authorization',
        element: {
          action_id: 'authorization',
          placeholder: plainText('Bearer …'),
          type: 'plain_text_input',
        },
        hint: plainText('Optional Authorization header value.'),
        label: plainText('Authorization'),
        optional: true,
        type: 'input',
      },
    ],
    callback_id: 'home_add_mcp_server',
    close: plainText('Cancel'),
    submit: plainText('Add'),
    title: plainText('Add MCP server'),
    type: 'modal',
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
