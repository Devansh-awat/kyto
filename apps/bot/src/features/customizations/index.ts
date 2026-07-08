import { personas } from '@repo/ai';
import {
  addMcpServer,
  cancelReminder,
  clearUserCustomization,
  getIdentityProfiles,
  getUserCustomization,
  pauseReminder,
  removeMcpServer,
  resumeReminder,
  setIdentityProfile,
  setUsageFooter,
  setUserCustomization,
} from '@repo/db/queries';
import { env } from '@/env';
import type { ModalSubmitEvent, ModalSubmitResult } from '@/harness';
import { mrkdwn, plainText } from '@/harness';
import { bot, slack } from '@/lib/chat';
import { IDENTITY_TYPES, resetIdentityCache } from '@/lib/identity';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import {
  openedViewSchema,
  parseModalState,
  promptFromViewValues,
  slackActionViewSchema,
} from './schema';
import { publishHome } from './service';
import {
  buildIdentityModal,
  buildMcpModal,
  buildPresetModal,
  buildPromptModal,
} from './views';

function isOwnerUser(userId: string): boolean {
  return Boolean(env.OWNER_USER_ID) && userId === env.OWNER_USER_ID;
}

bot.onAppHomeOpened(async (event) => {
  await publishHome({ userId: event.userId }).catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), userId: event.userId },
      'Failed to publish App Home'
    );
  });
});

bot.onAction('home_edit_prompt', async (event) => {
  if (!event.triggerId) {
    logger.warn(
      { userId: event.user.userId },
      'App Home action missing trigger ID'
    );
    return;
  }

  const opened = await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: {
        blocks: [
          {
            text: mrkdwn('Loading custom instructions...'),
            type: 'section',
          },
        ],
        callback_id: 'home_save_prompt',
        close: plainText('Cancel'),
        title: plainText('Custom Instructions'),
        type: 'modal',
      },
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open custom instructions modal'
      );
      return null;
    });
  const view = openedViewSchema.safeParse(opened?.view);
  if (!view.success) {
    return;
  }

  const customization = await getUserCustomization(event.user.userId).catch(
    (error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to load custom instructions for modal'
      );
      return null;
    }
  );

  await slack.webClient.views
    .update({
      hash: view.data.hash,
      view: buildPromptModal({
        prompt: customization?.prompt ?? null,
      }) as never,
      view_id: view.data.id,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to load custom instructions modal'
      );
    });
});

bot.onAction('modal_toggle_presets', async (event) => {
  const raw = slackActionViewSchema.safeParse(event.raw);
  if (!(raw.success && raw.data.view)) {
    logger.warn(
      { userId: event.user.userId },
      'Preset toggle action missing modal view'
    );
    return;
  }

  const state = parseModalState({ metadata: raw.data.view.private_metadata });
  const prompt = promptFromViewValues({ values: raw.data.view.state?.values });

  await slack.webClient.views
    .update({
      hash: raw.data.view.hash,
      view: buildPromptModal({
        prompt,
        showPresets: !state.showPresets,
      }) as never,
      view_id: raw.data.view.id,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to toggle custom instruction presets'
      );
    });
});

bot.onAction('modal_load_preset', async (event) => {
  const preset = personas.find((persona) => persona.id === event.value);
  if (!(preset && event.triggerId)) {
    logger.warn(
      { presetId: event.value, userId: event.user.userId },
      'Preset load action missing preset or trigger ID'
    );
    return;
  }

  await slack.webClient.views
    .push({
      trigger_id: event.triggerId,
      view: buildPresetModal(preset) as never,
    })
    .catch((error: unknown) => {
      logger.warn(
        {
          ...toLogError(error),
          presetId: preset.id,
          userId: event.user.userId,
        },
        'Failed to open custom instruction preset'
      );
    });
});

bot.onAction('home_clear_prompt', async (event) => {
  await clearUserCustomization(event.user.userId)
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to clear custom instructions'
      );
    });
});

bot.onAction('home_toggle_footer', async (event) => {
  // The button's value is the target state ('on'/'off'); fall back to reading
  // the current value if it's ever missing.
  const target = event.value
    ? event.value === 'on'
    : !(await getUserCustomization(event.user.userId))?.showUsageFooter;
  await setUsageFooter(event.user.userId, target)
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to toggle usage footer'
      );
    });
});

bot.onModalSubmit(
  ['home_save_prompt', 'home_save_preset_prompt'],
  async (event) => {
    const prompt = event.values.prompt?.trim();
    if (prompt === undefined) {
      return {
        action: 'errors',
        errors: { customization_prompt: 'Could not read custom instructions.' },
      };
    }

    try {
      if (prompt) {
        await setUserCustomization(event.user.userId, { prompt });
      } else {
        await clearUserCustomization(event.user.userId);
      }
    } catch (error) {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to save custom instructions'
      );
      return {
        action: 'errors',
        errors: {
          customization_prompt:
            'Could not save custom instructions. Try again.',
        },
      };
    }

    await publishHome({ userId: event.user.userId }).catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to refresh App Home after custom instructions save'
      );
    });

    if (event.callbackId === 'home_save_preset_prompt') {
      return { action: 'clear' };
    }
  }
);

// ── MCP servers (per-user, App Home) ────────────────────────────────────────

bot.onAction('home_add_mcp', async (event) => {
  if (!event.triggerId) {
    logger.warn(
      { userId: event.user.userId },
      'Add-MCP action missing trigger ID'
    );
    return;
  }
  await slack.webClient.views
    .open({ trigger_id: event.triggerId, view: buildMcpModal() as never })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open MCP modal'
      );
    });
});

bot.onAction('home_remove_mcp', async (event) => {
  const name = event.value;
  if (!name) {
    return;
  }
  await removeMcpServer({ name, userId: event.user.userId })
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), name, userId: event.user.userId },
        'Failed to remove MCP server'
      );
    });
});

bot.onModalSubmit(
  'home_add_mcp_server',
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    const name = event.values.mcp_name?.trim().toLowerCase();
    const url = event.values.mcp_url?.trim();
    const authorization = event.values.mcp_authorization?.trim() || undefined;
    if (!(name && /^[\w-]+$/.test(name))) {
      return {
        action: 'errors',
        errors: { mcp_name: 'Use letters, digits, - or _ only.' },
      };
    }
    if (!(url && /^https?:\/\//.test(url))) {
      return {
        action: 'errors',
        errors: { mcp_url: 'Enter an http(s) URL.' },
      };
    }
    try {
      await addMcpServer({
        authorization,
        name,
        url,
        userId: event.user.userId,
      });
    } catch (error) {
      logger.warn(
        { ...toLogError(error), name, userId: event.user.userId },
        'Failed to add MCP server'
      );
      return {
        action: 'errors',
        errors: { mcp_url: 'Could not save this server. Try again.' },
      };
    }
    await publishHome({ userId: event.user.userId }).catch(() => undefined);
    return;
  }
);

// ── Reminders (per-user, App Home) ──────────────────────────────────────────

async function handleReminderAction(
  event: { user: { userId: string }; value?: string },
  op: (args: { id: string; userId: string }) => Promise<boolean>,
  label: string
): Promise<void> {
  const id = event.value;
  if (!id) {
    return;
  }
  await op({ id, userId: event.user.userId })
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        `Failed to ${label} reminder`
      );
    });
}

bot.onAction('home_pause_reminder', (event) =>
  handleReminderAction(event, pauseReminder, 'pause')
);
bot.onAction('home_resume_reminder', (event) =>
  handleReminderAction(event, resumeReminder, 'resume')
);
bot.onAction('home_cancel_reminder', (event) =>
  handleReminderAction(event, cancelReminder, 'cancel')
);

// ── Identity (owner-only, App Home) ─────────────────────────────────────────

bot.onAction('home_edit_identity', async (event) => {
  if (!(event.triggerId && isOwnerUser(event.user.userId))) {
    return;
  }
  const profiles = await getIdentityProfiles().catch(() => []);
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: buildIdentityModal(profiles) as never,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open identity modal'
      );
    });
});

bot.onModalSubmit(
  'home_save_identity',
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    if (!isOwnerUser(event.user.userId)) {
      return;
    }
    try {
      for (const type of IDENTITY_TYPES) {
        await setIdentityProfile(type, {
          icon: event.values[`identity_${type}_icon`]?.trim() || null,
          nameSuffix: event.values[`identity_${type}_suffix`]?.trim() || null,
        });
      }
      resetIdentityCache();
    } catch (error) {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to save identity profiles'
      );
      return {
        action: 'errors',
        errors: { identity_normal_suffix: 'Could not save. Try again.' },
      };
    }
    await publishHome({ userId: event.user.userId }).catch(() => undefined);
    return;
  }
);
