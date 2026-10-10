import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness/thread';
import type { Message } from '@/harness/types';
import { parseBlocks } from '@/lib/ai/tools/post-message';
import { bot, slack } from '@/lib/chat';
import {
  allCodeChannels,
  canvasViews,
  disableCodeChannel,
  enableCodeChannel,
  getCodeChannel,
  rememberCanvasView,
} from '@/lib/code-channels';
import logger from '@/lib/logger';
import { callAgents, refusalText } from '@/lib/slack/code-channel-api';
import { errorMessage } from '@/lib/utils/error';

// Code channels (lib/code-channels). `create` makes a real Slack code channel
// through Slack's code channel API, with kyto's app as its agent, ONLY when
// someone asks (owner's call, 2026-10-10 — Slack suggests agents make one
// unasked for multi-step work). It is linked to the message that asked, so
// Slack adds its author, matches the origin's privacy and puts a join card on
// that message; a DM, group DM or Slack Connect channel can't be linked, so
// there it is made without one — private, with the requester invited. Then
// kyto picks the work up there in a handoff turn.
//
// Turning an EXISTING channel into one makes kyto answer every top-level
// message in it, so it is the channel's to decide: only its creator (or the
// bot owner) may. Off, or archived: whoever turned it on or asked for it, the
// channel's creator, or the owner — archiving only when someone asks.
//
// The rest (tabs, the context bar, slash commands, renaming) acts only on the
// code channel this turn is in, and needs a native one: Slack lets only a code
// channel's agent call them.

const VIEW_TYPES = ['html', 'diff', 'block_kit', 'canvas', 'pull_request'];
const CONTEXT_BAR_ICONS = [
  'branch',
  'folder',
  'hierarchy',
  'life-ring',
  'link',
  'globe',
  'terminal',
  'code',
  'search',
  'lock',
] as const;
const MAX_CONTEXT_BAR_ITEMS = 5;
const MAX_COMMANDS = 10;
const MAX_TITLE_CHARS = 200;
// Origins Slack won't link; the channel is created without one.
const UNLINKABLE_ORIGIN = new Set([
  'invalid_origin_link',
  'origin_channel_externally_shared',
  'origin_channel_is_file_channel',
]);

const infoSchema = z.looseObject({
  channel: z
    .looseObject({
      context_team_id: z.string().optional(),
      creator: z.string().optional(),
      is_im: z.boolean().optional(),
      is_member: z.boolean().optional(),
      is_mpim: z.boolean().optional(),
      is_private: z.boolean().optional(),
    })
    .optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});
const createdSchema = z.looseObject({ channel_id: z.string().optional() });
const viewSchema = z.looseObject({
  content_version: z.number().optional(),
  view_id: z.string().optional(),
});
const viewsSchema = z.looseObject({
  views: z
    .array(
      z.looseObject({
        content_version: z.number().optional(),
        label: z.string().optional(),
        view_id: z.string().optional(),
        view_key: z.string().optional(),
      })
    )
    .optional(),
});
const canvasCreatedSchema = z.looseObject({
  canvas_id: z.string().optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});
const canvasSchema = z.looseObject({
  comments: z
    .array(
      z.looseObject({
        is_resolved: z.boolean().optional(),
        quoted_text: z.string().optional(),
        replies: z
          .array(
            z.looseObject({
              text: z.string().optional(),
              user_id: z.string().optional(),
            })
          )
          .optional(),
        text: z.string().optional(),
        user_id: z.string().optional(),
      })
    )
    .optional(),
  content: z.string().optional(),
  title: z.string().optional(),
});
const sectionsSchema = z.looseObject({
  sections_changed_count: z.number().optional(),
});

async function channelInfo(channel: string) {
  return infoSchema.parse(
    await slack.webClient.apiCall('conversations.info', { channel })
  );
}

// Slack fails tab creations that race each other in one channel
// (`view_creation_failed`), and parallel tool calls make exactly that race.
const viewQueues = new Map<string, Promise<unknown>>();
function oneViewAtATime<T>({
  channel,
  run,
}: {
  channel: string;
  run: () => Promise<T>;
}): Promise<T> {
  const next = (viewQueues.get(channel) ?? Promise.resolve()).then(run, run);
  viewQueues.set(
    channel,
    next.catch(() => undefined)
  );
  return next;
}

/**
 * Pick the work up in the new channel: a kickoff line from kyto, then a turn
 * on the request, authored by the requester so it is gated as theirs. Not
 * awaited by the tool — it is a separate conversation.
 */
async function handOff({
  channel,
  message,
  name,
  originThreadId,
  task,
}: {
  channel: string;
  message: Message;
  name: string;
  originThreadId: string;
  task?: string;
}): Promise<void> {
  const threadId = slack.encodeThreadId({ channel, threadTs: '' });
  const thread = bot.thread(threadId);
  const sent = await thread.post(
    task ? `Picking this up here: ${task}` : 'Set up and ready.'
  );
  const { channel: originChannel, threadTs: originTs } =
    slack.decodeThreadId(originThreadId);
  const next = task
    ? `Carry on with it: ${task}`
    : 'All they asked for was the channel, so say briefly that it is ready, or skip.';
  const text = `[Handoff — nobody typed this. You just created the code channel "${name}" for <@${message.author.userId}> from <https://slack.com/archives/${originChannel}/p${originTs.replace('.', '')}|this thread> (read it with readConversationHistory if you need what was said there). ${next}]`;
  const { runTurn } = await import('@/lib/agent');
  await runTurn({
    message: {
      attachments: [],
      author: message.author,
      id: sent.id,
      isMention: true,
      metadata: { dateSent: new Date() },
      raw: {},
      text,
      threadId,
    },
    thread,
  });
}

export function codeChannelTool({
  isOwner,
  message,
  thread,
}: {
  isOwner: boolean;
  message: Message;
  thread: ThreadHandle;
}) {
  const authorUserId = message.author.userId;
  const { channel: currentChannel, threadTs: currentThreadTs } =
    slack.decodeThreadId(thread.id);

  /** The native code channel this turn is in, or why the action can't run. */
  async function hereNative(): Promise<
    { channel: string } | { error: string }
  > {
    const row = await getCodeChannel(currentChannel);
    if (!row?.native) {
      return {
        error:
          "This isn't a Slack code channel kyto is the agent of, so it has no tabs, context bar or commands.",
      };
    }
    return { channel: currentChannel };
  }

  async function create({
    isPrivate,
    name,
    task,
  }: {
    isPrivate?: boolean;
    name: string;
    task?: string;
  }) {
    const origin = await channelInfo(currentChannel).catch(() => undefined);
    const originPrivate =
      origin?.channel === undefined
        ? undefined
        : Boolean(
            origin.channel.is_im ||
              origin.channel.is_mpim ||
              origin.channel.is_private
          );
    const base = {
      name,
      // The request itself: asked again, Slack returns the same channel.
      session_id: `kyto:${currentChannel}:${message.id}`,
      ...(isPrivate || originPrivate !== undefined
        ? { is_private: Boolean(isPrivate || originPrivate) }
        : {}),
    };
    let linked = !(slack.isDM(thread.id) || origin?.channel?.is_mpim);
    let response = linked
      ? await callAgents({
          method: 'agents.conversations.create',
          params: {
            ...base,
            origin_channel_id: currentChannel,
            origin_message_ts: message.id,
          },
        })
      : undefined;
    if (
      !response ||
      (!response.ok && UNLINKABLE_ORIGIN.has(response.error ?? ''))
    ) {
      linked = false;
      const teamId = origin?.channel?.context_team_id ?? slack.teamId;
      response = await callAgents({
        method: 'agents.conversations.create',
        params: {
          ...base,
          // Unknown privacy: don't expose it.
          is_private: base.is_private ?? true,
          ...(teamId ? { team_id: teamId } : {}),
        },
      });
    }
    if (!response.ok) {
      return {
        error: `Could not create the code channel. ${refusalText(response)}`,
        success: false,
      };
    }
    const id = createdSchema.parse(response).channel_id;
    if (!id) {
      return {
        error: 'Slack reported success but returned no channel id.',
        success: false,
      };
    }
    // Registered before anything is posted there, so the channel's first
    // message is already answered as its one conversation.
    await enableCodeChannel({
      channelId: id,
      enabledBy: authorUserId,
      native: true,
      originThreadId: thread.id,
    });
    // Linked, Slack adds the requester itself; unlinked, kyto (its agent,
    // already in it) invites them.
    let requesterIn = linked;
    if (!linked) {
      requesterIn = await slack.webClient.conversations
        .invite({ channel: id, users: authorUserId })
        .then(() => true)
        .catch((error: unknown) => {
          const text = errorMessage(error);
          if (text.includes('already_in_channel')) {
            return true;
          }
          logger.warn(
            { channel: id, error: text },
            '[codeChannel] could not invite the requester'
          );
          return false;
        });
    }
    handOff({
      channel: id,
      message,
      name,
      originThreadId: thread.id,
      ...(task ? { task } : {}),
    }).catch((error: unknown) => {
      logger.warn(
        { channel: id, err: errorMessage(error) },
        '[codeChannel] handoff failed'
      );
    });
    let privacy = 'public';
    if (base.is_private === undefined && linked) {
      privacy = 'with the same privacy as this conversation';
    } else if (base.is_private ?? true) {
      privacy = 'private';
    }
    let joining = 'I could not add you to it — join from the channel link.';
    if (linked) {
      joining =
        'Slack put a join card on the request, so people here can join from it.';
    } else if (requesterIn) {
      joining = 'You were added to it.';
    }
    return {
      channel: `<#${id}>`,
      success: true,
      summary: `Created the code channel <#${id}> (${privacy}). ${joining} I'm picking the work up there now, so this thread doesn't need to continue it.`,
    };
  }

  async function enable(target: string) {
    const info = await channelInfo(target);
    if (!(info.ok && info.channel)) {
      return {
        error: `Could not read that channel: ${info.error ?? 'unknown error'}`,
        success: false,
      };
    }
    if (info.channel.is_im || info.channel.is_mpim) {
      return { error: 'Code channels are channels, not DMs.', success: false };
    }
    if (!(isOwner || info.channel.creator === authorUserId)) {
      return {
        error:
          "Only the channel's creator or the bot owner can make it a code channel — it would have me answer every message in it.",
        success: false,
      };
    }
    if (!info.channel.is_member) {
      if (info.channel.is_private) {
        return {
          error: 'Invite me to that private channel first.',
          success: false,
        };
      }
      await slack.webClient.apiCall('conversations.join', { channel: target });
    }
    await enableCodeChannel({ channelId: target, enabledBy: authorUserId });
    return {
      success: true,
      summary: `<#${target}> is now a code channel: I answer every top-level message in it, each in its own thread, and they share one sandbox.`,
    };
  }

  /** Whoever turned it on or asked for it, the channel's creator, the owner. */
  async function mayTurnOff(target: string) {
    const row = await getCodeChannel(target);
    if (!row) {
      return { error: `<#${target}> is not a code channel.` };
    }
    if (isOwner || row.enabledBy === authorUserId) {
      return { row };
    }
    const info = await channelInfo(target).catch(() => undefined);
    if (info?.channel?.creator === authorUserId) {
      return { row };
    }
    return {
      error:
        'Only whoever set it up, the channel creator or the bot owner can do that.',
    };
  }

  async function archive(summary?: string) {
    const here = await hereNative();
    if ('error' in here) {
      return { error: here.error, success: false };
    }
    const allowed = await mayTurnOff(here.channel);
    if ('error' in allowed) {
      return { error: allowed.error, success: false };
    }
    const summaryTs = summary
      ? (
          await bot
            .thread(
              slack.encodeThreadId({ channel: here.channel, threadTs: '' })
            )
            .post(summary)
        ).id
      : undefined;
    let response = await callAgents({
      method: 'agents.conversations.archive',
      params: {
        channel_id: here.channel,
        ...(summaryTs ? { summary_message_ts: summaryTs } : {}),
      },
    });
    // Shared back to the request only when there is one; otherwise just archive.
    if (!response.ok && response.error === 'no_origin_link' && summaryTs) {
      response = await callAgents({
        method: 'agents.conversations.archive',
        params: { channel_id: here.channel },
      });
    }
    if (!response.ok) {
      return { error: refusalText(response), success: false };
    }
    await disableCodeChannel(here.channel);
    return { success: true, summary: 'Archived the code channel.' };
  }

  async function setView(input: {
    baseBranch?: string;
    blocks?: string;
    content?: string;
    headBranch?: string;
    prUrl?: string;
    resourceDomains?: string[];
    viewKey?: string;
    viewName?: string;
    viewType?: string;
  }) {
    const here = await hereNative();
    if ('error' in here) {
      return { error: here.error, success: false };
    }
    const type = input.viewType ?? 'html';
    if (!VIEW_TYPES.includes(type)) {
      return {
        error: `viewType must be one of ${VIEW_TYPES.join(', ')}.`,
        success: false,
      };
    }
    const needsKey =
      type === 'html' || type === 'block_kit' || type === 'canvas';
    if (needsKey && !input.viewKey) {
      return {
        error: `A ${type} tab needs a viewKey (its stable id — reuse it to update the tab).`,
        success: false,
      };
    }
    const params: Record<string, unknown> = {
      channel_id: here.channel,
      type,
      ...(input.viewName ? { name: input.viewName } : {}),
      ...(needsKey ? { view_key: input.viewKey } : {}),
    };
    if (type === 'html' || type === 'diff') {
      if (!input.content) {
        return {
          error:
            type === 'html'
              ? 'An html tab needs content: a full HTML document.'
              : 'A diff tab needs content: unified diff text (git diff output).',
          success: false,
        };
      }
      params.content = input.content;
      if (type === 'html' && input.resourceDomains?.length) {
        params.csp = { resource_domains: input.resourceDomains };
      }
      if (type === 'diff') {
        Object.assign(params, {
          ...(input.baseBranch ? { base_branch: input.baseBranch } : {}),
          ...(input.headBranch ? { head_branch: input.headBranch } : {}),
        });
      }
    }
    if (type === 'block_kit') {
      const parsed = parseBlocks(input.blocks ?? '');
      if (parsed.error) {
        return { error: parsed.error, success: false };
      }
      params.blocks = parsed.blocks;
    }
    if (type === 'pull_request') {
      if (!input.prUrl) {
        return { error: 'A pull_request tab needs prUrl.', success: false };
      }
      params.pr_url = input.prUrl;
    }
    if (type === 'canvas') {
      if (!input.content) {
        return {
          error: 'A canvas tab needs content: the canvas as markdown.',
          success: false,
        };
      }
      const key = input.viewKey ?? '';
      const known = (await canvasViews(here.channel))[key];
      if (known) {
        // In place: comments on the sections that didn't change survive.
        const updated = await callAgents({
          method: 'agents.conversations.setCanvasContent',
          params: {
            canvas_id: known.canvasId,
            channel: here.channel,
            content: input.content,
          },
        });
        if (!updated.ok) {
          return { error: refusalText(updated), success: false };
        }
        const changed = sectionsSchema.parse(updated).sections_changed_count;
        return {
          success: true,
          summary: `Updated the ${key} canvas (${changed ?? 0} sections changed).`,
        };
      }
      const created = canvasCreatedSchema.parse(
        await slack.webClient.apiCall('canvases.create', {
          document_content: { markdown: input.content, type: 'markdown' },
          title: input.viewName ?? key,
        })
      );
      if (!(created.ok && created.canvas_id)) {
        return {
          error: `Could not create the canvas: ${created.error ?? 'unknown error'}`,
          success: false,
        };
      }
      // Comment, not write: people comment, kyto stays the canvas's author.
      Object.assign(params, {
        access_level: 'comment',
        canvas_id: created.canvas_id,
      });
    }
    const response = await oneViewAtATime({
      channel: here.channel,
      run: () => callAgents({ method: 'agents.conversations.setView', params }),
    });
    if (!response.ok) {
      return {
        error:
          response.error === 'view_creation_failed'
            ? `${refusalText(response)}. If it keeps failing for this viewKey, try a new one.`
            : refusalText(response),
        success: false,
      };
    }
    const view = viewSchema.parse(response);
    if (type === 'canvas' && typeof params.canvas_id === 'string') {
      await rememberCanvasView({
        channelId: here.channel,
        key: input.viewKey ?? '',
        view: {
          canvasId: params.canvas_id,
          name: input.viewName ?? input.viewKey ?? '',
          viewId: view.view_id ?? '',
        },
      });
    }
    return {
      success: true,
      summary: `Tab ${(view.content_version ?? 1) > 1 ? 'updated' : 'added'} (view_id ${view.view_id ?? 'unknown'}).`,
    };
  }

  return tool({
    description:
      "Slack CODE CHANNELS. `create` makes a real Slack code channel for a task (only when someone asks for one) and picks the work up there; `enable`/`disable` turn an existing channel (default: this one) into one where you answer every top-level message — only its creator or the bot owner may enable; `list` shows them. Inside a code channel you are the agent of: `setView` adds or updates a tab (html page, `diff`, `block_kit`, a `canvas` people comment on, a `pull_request`), `listViews`/`removeView`, `readCanvas` (a canvas tab's text and comments — read them before revising), `setContextBar` (≤5 items: repo, branch, PR, CI…; replaces the whole bar), `setCommands` (≤10 per-channel slash commands; using one sends you a message), `rename`, and `archive` with a summary — only when someone asks.",
    inputSchema: z.object({
      action: z.enum([
        'create',
        'enable',
        'disable',
        'list',
        'setView',
        'listViews',
        'removeView',
        'readCanvas',
        'setContextBar',
        'setCommands',
        'rename',
        'archive',
      ]),
      baseBranch: z.string().optional().describe('setView diff: base branch.'),
      blocks: z
        .string()
        .optional()
        .describe('setView block_kit: a JSON array of Block Kit blocks.'),
      channel: z
        .string()
        .regex(/^[CG][A-Z0-9]+$/)
        .optional()
        .describe('enable/disable: channel id. Defaults to this channel.'),
      commands: z
        .array(
          z.object({
            argumentHint: z.string().optional(),
            description: z.string().min(1),
            name: z
              .string()
              .regex(/^[a-z0-9][a-z0-9_-]{0,30}$/)
              .describe('Without the slash.'),
          })
        )
        .max(MAX_COMMANDS)
        .optional()
        .describe('setCommands: the whole set (an empty array clears them).'),
      content: z
        .string()
        .optional()
        .describe(
          'setView: html → a full HTML document; diff → unified diff text; canvas → markdown.'
        ),
      contextBar: z
        .array(
          z.object({
            icon: z.enum(CONTEXT_BAR_ICONS).optional(),
            key: z.string().min(1).max(64),
            label: z.string().min(1).max(128),
            url: z.string().url().max(2048).optional(),
          })
        )
        .max(MAX_CONTEXT_BAR_ITEMS)
        .optional()
        .describe('setContextBar: every item to show.'),
      headBranch: z.string().optional().describe('setView diff: head branch.'),
      includeResolved: z
        .boolean()
        .optional()
        .describe('readCanvas: include resolved comments.'),
      isPrivate: z.boolean().optional().describe('create: a private channel.'),
      name: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe(
          'create: the channel name, as the person wrote it (spaces fine).'
        ),
      prUrl: z.string().url().optional().describe('setView pull_request.'),
      resourceDomains: z
        .array(z.string())
        .optional()
        .describe(
          'setView html: https origins the page may load scripts/styles/images from.'
        ),
      summary: z
        .string()
        .optional()
        .describe(
          'archive: a summary posted in the channel and on the request.'
        ),
      task: z
        .string()
        .optional()
        .describe(
          'create: what to do in the new channel, self-contained — you continue from it there.'
        ),
      title: z
        .string()
        .min(1)
        .max(MAX_TITLE_CHARS)
        .optional()
        .describe('rename: the new title (renames the channel).'),
      viewId: z.string().optional().describe('removeView: a tab by its id.'),
      viewKey: z
        .string()
        .optional()
        .describe(
          'setView/removeView/readCanvas: your stable id for a tab; the same key updates the same tab.'
        ),
      viewName: z.string().optional().describe('setView: the tab label.'),
      viewType: z
        .enum(['html', 'diff', 'block_kit', 'canvas', 'pull_request'])
        .optional()
        .describe('setView: the kind of tab (default html).'),
    }),
    execute: async (input) => {
      try {
        switch (input.action) {
          case 'list': {
            const rows = await allCodeChannels();
            return {
              channels: rows.map((row) => ({
                channel: `<#${row.channelId}>`,
                enabledBy: `<@${row.enabledBy}>`,
                kind: row.native ? 'slack code channel' : 'ordinary channel',
              })),
              success: true,
            };
          }
          case 'create':
            if (!input.name) {
              return { error: 'create needs a name.', success: false };
            }
            return await create({
              name: input.name,
              ...(input.isPrivate === undefined
                ? {}
                : { isPrivate: input.isPrivate }),
              ...(input.task ? { task: input.task } : {}),
            });
          case 'enable': {
            const target = input.channel ?? currentChannel;
            if (!/^[CG]/.test(target)) {
              return {
                error: 'Code channels are channels, not DMs.',
                success: false,
              };
            }
            return await enable(target);
          }
          case 'disable': {
            const target = input.channel ?? currentChannel;
            const allowed = await mayTurnOff(target);
            if ('error' in allowed) {
              return { error: allowed.error, success: false };
            }
            await disableCodeChannel(target);
            return {
              success: true,
              summary: allowed.row.native
                ? `I no longer answer every message in <#${target}>. It is still a Slack code channel; archive it to close it.`
                : `<#${target}> is a normal channel again.`,
            };
          }
          case 'archive':
            return await archive(input.summary);
          case 'setView':
            return await setView(input);
          case 'listViews': {
            const here = await hereNative();
            if ('error' in here) {
              return { error: here.error, success: false };
            }
            const response = await callAgents({
              method: 'agents.conversations.listViews',
              params: { channel_id: here.channel },
            });
            if (!response.ok) {
              return { error: refusalText(response), success: false };
            }
            const canvases = await canvasViews(here.channel);
            return {
              success: true,
              views: [
                ...(viewsSchema.parse(response).views ?? []).map((view) => ({
                  label: view.label,
                  version: view.content_version,
                  viewId: view.view_id,
                  viewKey: view.view_key ?? '(the diff)',
                })),
                ...Object.entries(canvases).map(([key, view]) => ({
                  label: `${view.name} (canvas)`,
                  viewId: view.viewId,
                  viewKey: key,
                })),
              ],
            };
          }
          case 'removeView': {
            const here = await hereNative();
            if ('error' in here) {
              return { error: here.error, success: false };
            }
            if (Boolean(input.viewKey) === Boolean(input.viewId)) {
              return {
                error: 'Give exactly one of viewKey or viewId.',
                success: false,
              };
            }
            if (
              input.viewKey &&
              (await canvasViews(here.channel))[input.viewKey]
            ) {
              return {
                error:
                  "Slack can't remove a canvas tab through its API. Someone can remove it from the channel's tabs, or keep it and update it instead.",
                success: false,
              };
            }
            const response = await callAgents({
              method: 'agents.conversations.removeView',
              params: {
                channel_id: here.channel,
                ...(input.viewKey
                  ? { view_key: input.viewKey }
                  : { view_id: input.viewId }),
              },
            });
            return response.ok
              ? { success: true, summary: 'Tab removed.' }
              : { error: refusalText(response), success: false };
          }
          case 'readCanvas': {
            const here = await hereNative();
            if ('error' in here) {
              return { error: here.error, success: false };
            }
            const canvases = await canvasViews(here.channel);
            const known = canvases[input.viewKey ?? ''];
            if (!known) {
              return {
                error: `No canvas tab with that viewKey here (canvas tabs: ${Object.keys(canvases).join(', ') || 'none'}).`,
                success: false,
              };
            }
            const response = await callAgents({
              method: 'agents.conversations.getCanvas',
              params: {
                canvas_id: known.canvasId,
                channel: here.channel,
                include_resolved: input.includeResolved ?? false,
              },
            });
            if (!response.ok) {
              return { error: refusalText(response), success: false };
            }
            const canvas = canvasSchema.parse(response);
            return {
              comments: (canvas.comments ?? []).map((comment) => ({
                by: `<@${comment.user_id ?? 'unknown'}>`,
                on: comment.quoted_text,
                replies: (comment.replies ?? []).map(
                  (reply) => `<@${reply.user_id ?? 'unknown'}>: ${reply.text}`
                ),
                resolved: comment.is_resolved === true,
                text: comment.text,
              })),
              content: canvas.content,
              success: true,
              title: canvas.title,
            };
          }
          case 'setContextBar': {
            const here = await hereNative();
            if ('error' in here) {
              return { error: here.error, success: false };
            }
            const response = await callAgents({
              method: 'agents.conversations.setProperties',
              params: {
                channel_id: here.channel,
                code_channel: { context_bar_items: input.contextBar ?? [] },
              },
            });
            return response.ok
              ? { success: true, summary: 'Context bar updated.' }
              : { error: refusalText(response), success: false };
          }
          case 'setCommands': {
            const here = await hereNative();
            if ('error' in here) {
              return { error: here.error, success: false };
            }
            const commands = (input.commands ?? []).map((command) => ({
              description: command.description,
              name: command.name,
              ...(command.argumentHint
                ? { argument_hint: command.argumentHint }
                : {}),
            }));
            const response = await callAgents({
              method: 'agents.conversations.setCommands',
              params: { channel_id: here.channel, commands },
            });
            return response.ok
              ? {
                  success: true,
                  summary: `Registered ${commands.length} slash commands in this channel.`,
                }
              : { error: refusalText(response), success: false };
          }
          case 'rename': {
            const here = await hereNative();
            if ('error' in here) {
              return { error: here.error, success: false };
            }
            if (!input.title) {
              return { error: 'rename needs a title.', success: false };
            }
            const response = await callAgents({
              method: 'agents.sessions.rename',
              params: { channel_id: here.channel, title: input.title },
            });
            return response.ok
              ? { success: true, summary: 'Renamed.' }
              : { error: refusalText(response), success: false };
          }
          default:
            return { error: 'Unknown action.', success: false };
        }
      } catch (error) {
        logger.warn(
          { error: errorMessage(error), threadTs: currentThreadTs },
          '[codeChannel] failed'
        );
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
