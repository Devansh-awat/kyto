import nodePath from 'node:path/posix';
import { type SandboxContext, subagentAttempt } from '@repo/ai';
import { listMcpServers } from '@repo/db/queries';
import { type Tool, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { KytoBot, Message, ThreadHandle } from '@/harness';
import { buildMcpTools } from '@/lib/ai/mcp';
import logger from '@/lib/logger';
import { backgroundProcessTools } from './tools/background';
import { browserTool } from './tools/browser';
import {
  canvasDeleteTool,
  canvasListTool,
  canvasReadTool,
  canvasWriteTool,
} from './tools/canvas';
import { createChannelTool, setChannelTopicTool } from './tools/channels';
import { codeModeTool } from './tools/code-mode';
import {
  deploySiteTool,
  listSitesTool,
  removeSiteTool,
} from './tools/deploy-site';
import { checkInboxTool, replyEmailTool, sendEmailTool } from './tools/email';
import { deleteFileTool, fileStatTool } from './tools/files';
import { focusModeTool } from './tools/focus';
import { generateImageTool } from './tools/generate-image';
import { getChannelInfoTool } from './tools/get-channel-info';
import { getFileTool } from './tools/get-file';
import { getUserTool } from './tools/get-user';
import { ghTool } from './tools/gh';
import { joinThreadTool } from './tools/join-thread';
import { leaveThreadTool } from './tools/leave-thread';
import { listThreadsTool } from './tools/list-threads';
import {
  editMemoryTool,
  fetchMemoryTool,
  saveMemoryTool,
} from './tools/memory';
import { mermaidTool } from './tools/mermaid';
import {
  bookmarkLinkTool,
  pinMessageTool,
  unpinMessageTool,
} from './tools/pins';
import { pollTool } from './tools/poll';
import { postMessageTool } from './tools/post-message';
import { reactTool, unreactTool } from './tools/react';
import { readConversationHistoryTool } from './tools/read-conversation-history';
import {
  cancelReminderTool,
  editReminderTool,
  listRemindersTool,
  pauseReminderTool,
  resumeReminderTool,
  scheduleRecurringReminderTool,
} from './tools/reminders';
import {
  bashTool,
  editFileTool,
  readFileTool,
  writeFileTool,
} from './tools/sandbox';
import { scheduleReminderTool } from './tools/schedule-reminder';
import { searchSlackTool } from './tools/search-slack';
import { searchWebTool } from './tools/search-web';
import { editAsUserTool, sendAsUserTool } from './tools/send-as-user';
import { skipTool } from './tools/skip';
import { slackScriptTool } from './tools/slack-script';
import { runSubagentTool } from './tools/subagent';
import { summarizeThreadTool } from './tools/summarize-thread';
import { textToSpeechTool } from './tools/text-to-speech';
import { uploadFileTool } from './tools/upload-file';
import { fetchUrlTool, getPermalinkTool } from './tools/url';
import { waitTool } from './tools/wait';

export interface BuiltTools {
  /** Live view of the tool names currently exposed to the model. */
  activeTools: () => string[];
  /** Close per-turn resources (MCP connections). */
  close: () => Promise<void>;
  tools: ToolSet;
}

/**
 * Build the turn's toolset. Core tools are always visible; uncommon tools
 * (browser, email, rare Slack ops) and the user's MCP tools are DEFERRED —
 * registered but hidden from the model until it calls `loadTools`, so their
 * schemas don't ride along in every prompt. `activeTools` feeds streamText's
 * prepareStep, which is what actually gates visibility per step.
 */
export async function buildTools({
  bot,
  extendAttemptDeadline,
  getSandboxContext,
  message,
  thread,
}: {
  bot: KytoBot;
  /**
   * Push the running attempt's watchdog out. The `wait` tool calls it so a long
   * deliberate pause is never mistaken for a stalled attempt. Absent for callers
   * with no watchdog of their own (the subagent, reminders).
   */
  extendAttemptDeadline?: (extraMs: number) => void;
  getSandboxContext: () => SandboxContext;
  message: Message;
  thread: ThreadHandle;
}): Promise<BuiltTools> {
  const authorUserId = message.author.userId;
  const isOwner =
    Boolean(env.OWNER_USER_ID) && authorUserId === env.OWNER_USER_ID;
  const canActAsOwner = Boolean(env.SLACK_USER_TOKEN) && isOwner;
  const agentMailKey = env.AGENTMAIL_API_KEY;

  const core: ToolSet = {
    bash: bashTool({ getSandboxContext }),
    codeMode: codeModeTool({ getSandboxContext }),
    readFile: readFileTool({ getSandboxContext }),
    writeFile: writeFileTool({ getSandboxContext }),
    editFile: editFileTool({ getSandboxContext }),
    deleteFile: deleteFileTool({ getSandboxContext }),
    fileStat: fileStatTool({ getSandboxContext }),
    wait: waitTool({ extendAttemptDeadline, getSandboxContext }),
    react: reactTool({ bot }),
    unreact: unreactTool({ bot }),
    getUser: getUserTool(),
    postMessage: postMessageTool({
      authorUserId,
      bot,
      currentThreadId: thread.id,
      extendAttemptDeadline,
      isOwner,
    }),
    getFile: getFileTool({ getSandboxContext }),
    joinThread: joinThreadTool({ thread }),
    leaveThread: leaveThreadTool({ thread }),
    focusMode: focusModeTool({ thread }),
    canvasRead: canvasReadTool(),
    canvasWrite: canvasWriteTool({ thread }),
    canvasList: canvasListTool({ thread }),
    getPermalink: getPermalinkTool({ thread }),
    fetchUrl: fetchUrlTool(),
    deploySite: deploySiteTool({
      getSandboxContext,
      isOwner,
      userId: authorUserId,
    }),
    listSites: listSitesTool(),
    removeSite: removeSiteTool({ isOwner, userId: authorUserId }),
    skip: skipTool({ threadId: thread.id }),
    saveMemory: saveMemoryTool({ authorUserId }),
    fetchMemory: fetchMemoryTool(),
    editMemory: editMemoryTool(),
    listThreads: listThreadsTool({ currentThreadId: thread.id }),
    readConversationHistory: readConversationHistoryTool({
      currentThreadId: thread.id,
    }),
    getChannelInfo: getChannelInfoTool({ currentThreadId: thread.id }),
    scheduleReminder: scheduleReminderTool({ message }),
    scheduleRecurringReminder: scheduleRecurringReminderTool({ message }),
    listReminders: listRemindersTool({ message }),
    editReminder: editReminderTool({ message }),
    cancelReminder: cancelReminderTool({ message }),
    pauseReminder: pauseReminderTool({ message }),
    resumeReminder: resumeReminderTool({ message }),
    searchSlack: searchSlackTool({ message }),
    searchWeb: searchWebTool({ apiKey: env.EXA_API_KEY }),
    summarizeThread: summarizeThreadTool({ bot, threadId: thread.id }),
    generateImage: generateImageTool({
      upload: async ({ bytes, mediaType, index, total }) => {
        const filename = `kyto-image-${index + 1}.${mediaType.split('/').at(1) ?? 'png'}`;
        await thread.post({
          files: [{ data: bytes, filename }],
          markdown:
            total > 1 ? `Generated image ${index + 1}` : 'Generated image',
        });
      },
    }),
    uploadFile: uploadFileTool({
      upload: async ({ filename, path, title }) => {
        const sandboxContext = getSandboxContext();
        const { session, sessionWorkDir } = sandboxContext;
        const sandboxPath = nodePath.normalize(
          path.startsWith('/') ? path : nodePath.join(sessionWorkDir, path)
        );
        if (
          sandboxPath !== sessionWorkDir &&
          !sandboxPath.startsWith(`${sessionWorkDir}/`)
        ) {
          throw new Error(
            'uploadFile can only upload files from the workspace.'
          );
        }
        const bytes = await session.readBinaryFile({ path: sandboxPath });
        if (!bytes) {
          throw new Error(`Could not find file: ${path}`);
        }
        const resolvedFilename =
          filename ?? nodePath.basename(sandboxPath) ?? 'artifact';
        await thread.post({
          files: [{ data: bytes, filename: resolvedFilename }],
          markdown: title ?? resolvedFilename,
        });
        return { filename: resolvedFilename, uploaded: true };
      },
    }),
  };

  // Background-process trio shares one in-turn handle map, so build it once.
  const background = backgroundProcessTools({ getSandboxContext });
  const ttsAvailable = Boolean(
    env.HACKCLUB_REPLICATE_API_KEY || env.GEMINI_API_KEY
  );

  // Deferred: registered but hidden until loadTools names them.
  const deferred: Record<string, { summary: string; tool: Tool }> = {
    browser: {
      summary: 'drive a real Chromium browser (screenshots, clicks, scraping)',
      tool: browserTool({ getSandboxContext }),
    },
    runBackgroundProcess: {
      summary: 'start a long-running shell command in the background',
      tool: background.runBackgroundProcess,
    },
    getProcessOutput: {
      summary: 'read output / status of a background process',
      tool: background.getProcessOutput,
    },
    killProcess: {
      summary: 'kill a background process',
      tool: background.killProcess,
    },
    canvasDelete: {
      summary: 'delete a Slack canvas',
      tool: canvasDeleteTool(),
    },
    createChannel: {
      summary: 'create a Slack channel',
      tool: createChannelTool(),
    },
    setChannelTopic: {
      summary: 'set a channel topic',
      tool: setChannelTopicTool({ thread }),
    },
    bookmarkLink: {
      summary: 'add a bookmark to a channel',
      tool: bookmarkLinkTool({ thread }),
    },
    pinMessage: {
      summary: 'pin a message',
      tool: pinMessageTool({ authorUserId, thread }),
    },
    unpinMessage: {
      summary: 'unpin a message',
      tool: unpinMessageTool({ authorUserId, thread }),
    },
    poll: {
      summary: 'post an interactive poll',
      tool: pollTool({ thread }),
    },
    mermaid: {
      summary: 'render a mermaid diagram as an image',
      tool: mermaidTool({ thread }),
    },
    ...(env.GH_TOKEN
      ? {
          gh: {
            summary: 'run a GitHub CLI (`gh`) command in the sandbox',
            tool: ghTool({ getSandboxContext }),
          },
        }
      : {}),
    ...(env.SITES_ENABLED
      ? {
          slackScript: {
            summary:
              'run a read-only bash script against the Slack API (aggregate queries)',
            tool: slackScriptTool({ getSandboxContext }),
          },
        }
      : {}),
    ...(subagentAttempt
      ? (() => {
          const subagent = runSubagentTool({
            getSandboxContext,
            bot,
            message,
            thread,
          });
          return {
            runSubagent: {
              summary:
                'delegate a task to a headless subagent that returns a report',
              tool: subagent.runSubagent,
            },
            checkSubagent: {
              summary:
                'check / collect a background subagent started with runSubagent',
              tool: subagent.checkSubagent,
            },
          };
        })()
      : {}),
    ...(ttsAvailable
      ? {
          textToSpeech: {
            summary: 'convert text to spoken audio and upload it to the thread',
            tool: textToSpeechTool({
              upload: async ({ data, filename }) => {
                await thread.post({
                  files: [{ data: new Uint8Array(data), filename }],
                  markdown: 'Generated audio',
                });
              },
            }),
          },
        }
      : {}),
    ...(agentMailKey
      ? {
          sendEmail: {
            summary: 'send an email from kyto’s inbox',
            tool: sendEmailTool({ apiKey: agentMailKey }),
          },
          checkInbox: {
            summary: 'check kyto’s email inbox',
            tool: checkInboxTool({ apiKey: agentMailKey }),
          },
          replyEmail: {
            summary: 'reply to an email thread',
            tool: replyEmailTool({ apiKey: agentMailKey }),
          },
        }
      : {}),
    ...(canActAsOwner
      ? {
          sendAsUser: {
            summary: 'send a Slack message AS the owner',
            tool: sendAsUserTool({
              authorUserId,
              extendAttemptDeadline,
              thread,
            }),
          },
          editAsUser: {
            summary: 'edit one of the owner’s Slack messages',
            tool: editAsUserTool({
              authorUserId,
              extendAttemptDeadline,
              thread,
            }),
          },
        }
      : {}),
  };

  // The requesting user's remote MCP servers (added via kyto's App Home tab),
  // also deferred behind loadTools.
  const servers = await listMcpServers(authorUserId).catch((error: unknown) => {
    logger.warn({ err: error, userId: authorUserId }, '[mcp] listing failed');
    return [];
  });
  const mcp = await buildMcpTools({ logger, servers });
  for (const [name, mcpTool] of Object.entries(mcp.tools)) {
    deferred[name] = {
      summary: `MCP tool (${name})`,
      tool: mcpTool,
    };
  }

  const catalog = Object.entries(deferred)
    .map(([name, entry]) => `- ${name}: ${entry.summary}`)
    .join('\n');
  const active = new Set(Object.keys(core));
  active.add('loadTools');

  const loadTools = tool({
    description: `Load additional tools by name before using them (their schemas stay out of the prompt until needed). Available:\n${catalog || '- (none)'}`,
    inputSchema: z.object({
      tools: z
        .array(z.string())
        .min(1)
        .describe('Deferred tool names to load.'),
    }),
    execute: ({ tools: names }) => {
      const loaded: string[] = [];
      const unknown: string[] = [];
      for (const name of names) {
        if (deferred[name]) {
          active.add(name);
          loaded.push(name);
        } else {
          unknown.push(name);
        }
      }
      return Promise.resolve({
        loaded,
        summary: loaded.length
          ? `Loaded: ${loaded.join(', ')}. They are available as tools from the next step.`
          : 'No matching tools.',
        unknown,
      });
    },
  });

  const tools: ToolSet = {
    ...core,
    loadTools,
    ...Object.fromEntries(
      Object.entries(deferred).map(([name, entry]) => [name, entry.tool])
    ),
  };

  return {
    activeTools: () => [...active],
    close: mcp.close,
    tools,
  };
}
