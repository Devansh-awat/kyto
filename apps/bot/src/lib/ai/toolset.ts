import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import type { ToolSet } from 'ai';
import type { Chat, Message, Thread } from 'chat';
import { env } from '@/env';
import { backgroundProcessTools } from './tools/background';
import { browseTool } from './tools/browse';
import {
  canvasDeleteTool,
  canvasListTool,
  canvasReadTool,
  canvasWriteTool,
} from './tools/canvas';
import { createChannelTool, setChannelTopicTool } from './tools/channels';
import { deploySiteTool, removeSiteTool } from './tools/deploy-site';
import { checkInboxTool, replyEmailTool, sendEmailTool } from './tools/email';
import { deleteFileTool, fileStatTool } from './tools/files';
import { generateImageTool } from './tools/generate-image';
import { getChannelInfoTool } from './tools/get-channel-info';
import { getFileTool } from './tools/get-file';
import { getUserTool } from './tools/get-user';
import { joinThreadTool } from './tools/join-thread';
import { leaveThreadTool } from './tools/leave-thread';
import { listThreadsTool } from './tools/list-threads';
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
  listRemindersTool,
  pauseReminderTool,
  resumeReminderTool,
  scheduleRecurringReminderTool,
} from './tools/reminders';
import { scheduleReminderTool } from './tools/schedule-reminder';
import { searchSlackTool } from './tools/search-slack';
import { searchWebTool } from './tools/search-web';
import { editAsUserTool, sendAsUserTool } from './tools/send-as-user';
import { skipTool } from './tools/skip';
import { runSubagentTool } from './tools/subagent';
import { summarizeThreadTool } from './tools/summarize-thread';
import { textToSpeechTool } from './tools/text-to-speech';
import { uploadFileTool } from './tools/upload-file';
import { fetchUrlTool, getPermalinkTool } from './tools/url';
import { waitTool } from './tools/wait';

export function buildTools({
  bot,
  getSandboxContext,
  message,
  thread,
}: {
  bot: Chat;
  getSandboxContext: () => SandboxContext | undefined;
  message: Message;
  thread: Thread;
}): ToolSet {
  // Only expose "act as the owner" tools when this turn was triggered by the
  // owner. Registering them conditionally means other users never get access.
  const authorUserId = message.author.userId;
  const canActAsOwner =
    Boolean(env.SLACK_USER_TOKEN) &&
    Boolean(env.OWNER_USER_ID) &&
    authorUserId === env.OWNER_USER_ID;

  // Email tools run host-side via AgentMail; only registered when a key is set.
  const agentMailKey = env.AGENTMAIL_API_KEY;
  const hasVoiceKey = Boolean(
    env.HACKCLUB_REPLICATE_API_KEY || env.GEMINI_API_KEY
  );

  const { runBackgroundProcess, getProcessOutput, killProcess } =
    backgroundProcessTools({ getSandboxContext });

  return {
    react: reactTool({ bot }),
    unreact: unreactTool({ bot }),
    wait: waitTool(),
    deleteFile: deleteFileTool({ getSandboxContext }),
    fileStat: fileStatTool({ getSandboxContext }),
    runBackgroundProcess,
    getProcessOutput,
    killProcess,
    getUser: getUserTool(),
    postMessage: postMessageTool({ bot }),
    getFile: getFileTool({ getSandboxContext }),
    joinThread: joinThreadTool({ thread }),
    leaveThread: leaveThreadTool({ thread }),
    ...(canActAsOwner && {
      sendAsUser: sendAsUserTool({ authorUserId, thread }),
      editAsUser: editAsUserTool({ authorUserId, thread }),
    }),
    canvasRead: canvasReadTool(),
    canvasWrite: canvasWriteTool({ thread }),
    canvasList: canvasListTool({ thread }),
    canvasDelete: canvasDeleteTool(),
    pinMessage: pinMessageTool({ authorUserId, thread }),
    unpinMessage: unpinMessageTool({ authorUserId, thread }),
    bookmarkLink: bookmarkLinkTool({ thread }),
    createChannel: createChannelTool(),
    setChannelTopic: setChannelTopicTool({ thread }),
    poll: pollTool({ thread }),
    getPermalink: getPermalinkTool({ thread }),
    fetchUrl: fetchUrlTool(),
    deploySite: deploySiteTool({ getSandboxContext }),
    removeSite: removeSiteTool(),
    browse: browseTool({ getSandboxContext }),
    ...(hasVoiceKey && {
      textToSpeech: textToSpeechTool({
        upload: async ({ data, filename }) => {
          await thread.post({
            files: [{ data, filename }],
            markdown: 'Generated speech',
          });
        },
      }),
    }),
    ...(agentMailKey && {
      sendEmail: sendEmailTool({ apiKey: agentMailKey }),
      checkInbox: checkInboxTool({ apiKey: agentMailKey }),
      replyEmail: replyEmailTool({ apiKey: agentMailKey }),
    }),
    skip: skipTool({ threadId: thread.id }),
    listThreads: listThreadsTool({ currentThreadId: thread.id }),
    readConversationHistory: readConversationHistoryTool({
      currentThreadId: thread.id,
    }),
    getChannelInfo: getChannelInfoTool({ currentThreadId: thread.id }),
    mermaid: mermaidTool({ thread }),
    scheduleReminder: scheduleReminderTool({ message }),
    scheduleRecurringReminder: scheduleRecurringReminderTool({ message }),
    listReminders: listRemindersTool({ message }),
    cancelReminder: cancelReminderTool({ message }),
    pauseReminder: pauseReminderTool({ message }),
    resumeReminder: resumeReminderTool({ message }),
    searchSlack: searchSlackTool({ message }),
    searchWeb: searchWebTool({ apiKey: env.EXA_API_KEY }),
    summarizeThread: summarizeThreadTool({ bot, threadId: thread.id }),
    runSubagent: runSubagentTool({ bot, message, thread }),
    generateImage: generateImageTool({
      upload: async ({ bytes, mediaType, index, total }) => {
        const filename = `kyto-image-${index + 1}.${mediaType.split('/').at(1) ?? 'png'}`;
        await thread.post({
          files: [{ data: Buffer.from(bytes), filename }],
          markdown:
            total > 1 ? `Generated image ${index + 1}` : 'Generated image',
        });
      },
    }),
    uploadFile: uploadFileTool({
      upload: async ({ filename, path, title }) => {
        const sandboxContext = getSandboxContext();
        if (!sandboxContext) {
          throw new Error('No active sandbox session is available.');
        }

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
          files: [{ data: Buffer.from(bytes), filename: resolvedFilename }],
          markdown: title ?? resolvedFilename,
        });
        return { filename: resolvedFilename, uploaded: true };
      },
    }),
  };
}
