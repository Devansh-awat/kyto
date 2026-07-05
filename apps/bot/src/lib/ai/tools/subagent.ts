import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs, tool } from 'ai';
import type { Chat, Message, Thread } from 'chat';
import { z } from 'zod';
import { env } from '@/env';
import { errorMessage } from '@/lib/utils/error';
import { getChannelInfoTool } from './get-channel-info';
import { getUserTool } from './get-user';
import { listThreadsTool } from './list-threads';
import { readConversationHistoryTool } from './read-conversation-history';
import { searchSlackTool } from './search-slack';
import { searchWebTool } from './search-web';
import { summarizeThreadTool } from './summarize-thread';
import { fetchUrlTool } from './url';

// A lightweight delegate for open-ended research that would otherwise burn
// through the main turn's own context (many searches/fetches whose raw
// results aren't worth keeping around). By default runs through HackClub's
// openrouter/auto (same tuning/cost-bias as the main turn — see
// resolved-model.ts's global fetch patch, which keys off the request URL/
// model id, not which code path called it) as a plain generateText tool
// loop, NOT the full Pi harness: no sandbox, no session, just a curated
// read-only research toolset. It cannot post, react, or otherwise act — only
// investigate and report back.
//
// A recurring 'agent' reminder (lib/reminders/agent.ts) builds its own tools
// with `pinnedModel` set to its own Gemini attempt, so a subagent it launches
// never touches openrouter/auto/HackClub either — keeping the whole
// unattended job's cost on the same predictable, separate quota.
const SUBAGENT_MAX_STEPS = 8;

const SUBAGENT_SYSTEM_PROMPT =
  'You are a focused research subagent delegated a single task by the main kyto agent. You have read-only research tools (searchWeb, searchSlack, fetchUrl, getUser, getChannelInfo, readConversationHistory, listThreads, summarizeThread) but cannot post messages, react, or otherwise act. Investigate thoroughly using the tools available, then reply with ONLY a clear, well-organized written report of your findings — no preamble, no meta-commentary about being a subagent.';

export function runSubagentTool({
  bot,
  message,
  pinnedModel,
  thread,
}: {
  bot: Chat;
  message: Message;
  /** Override the default openrouter/auto model, e.g. to pin to Gemini. */
  pinnedModel?: { model: string; apiKey: string; baseURL: string };
  thread: Thread;
}) {
  return tool({
    description:
      'Delegate a focused research task to a lightweight subagent with its own tool loop and separate context — use for open-ended investigation (searching Slack/the web, reading history, looking things up) that would otherwise clutter your own context. Returns a written report. It is read-only: it cannot post messages, react, or take any action, only investigate and report back.',
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .describe(
          'The research task or question to delegate, with as much detail/context as the subagent will need (it has no access to this conversation).'
        ),
    }),
    execute: async ({ task }) => {
      try {
        const provider = createOpenAICompatible({
          apiKey: pinnedModel?.apiKey ?? env.HACKCLUB_API_KEY,
          baseURL: pinnedModel?.baseURL ?? 'https://ai.hackclub.com/proxy/v1',
          name: pinnedModel ? 'gemini' : 'hackclub',
        });
        const { text } = await generateText({
          model: provider.languageModel(
            pinnedModel?.model ?? 'openrouter/auto'
          ),
          prompt: task,
          stopWhen: stepCountIs(SUBAGENT_MAX_STEPS),
          system: SUBAGENT_SYSTEM_PROMPT,
          tools: {
            fetchUrl: fetchUrlTool(),
            getChannelInfo: getChannelInfoTool({ currentThreadId: thread.id }),
            getUser: getUserTool(),
            listThreads: listThreadsTool({ currentThreadId: thread.id }),
            readConversationHistory: readConversationHistoryTool({
              currentThreadId: thread.id,
            }),
            searchSlack: searchSlackTool({ message }),
            searchWeb: searchWebTool({ apiKey: env.EXA_API_KEY }),
            summarizeThread: summarizeThreadTool({ bot, threadId: thread.id }),
          },
        });
        const report = text.trim();
        if (!report) {
          return {
            error: 'Subagent produced an empty report.',
            success: false,
          };
        }
        return { report, success: true };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
