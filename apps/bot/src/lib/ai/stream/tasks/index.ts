import { originalToolName } from '@/lib/ai/merge-tools';
import { clamp } from '@/lib/utils/text';
import type {
  DefaultTaskRenderer,
  TaskRendererEntry,
} from '@/types/task-renderers';
import {
  fetchMessages,
  getChannelInfo,
  getUser,
  listThreads,
  message,
  reaction,
} from './chat';
import { defaultTool } from './default';
import { generateImage } from './generate-image';
import { getFile } from './get-file';
import { errorOutput, resultErrorOutput, value } from './helpers';
import { leaveThread } from './leave-thread';
import { mermaid } from './mermaid';
import { command, file, search } from './pi';
import { scheduleReminder } from './schedule-reminder';
import { searchSlack } from './search-slack';
import { searchWeb } from './search-web';
import { summarizeThread } from './summarize-thread';
import { uploadFile } from './upload-file';

type RenderPhase = 'request' | 'response' | 'error';

const renderers: Record<string, TaskRendererEntry> = {
  bash: command,
  compaction: { title: 'Compacting context' },
  edit: { ...file, title: 'Editing file' },
  fileChange: { ...file, title: 'File updated' },
  generateImage,
  getChannelInfo,
  getFile,
  getUser,
  glob: { ...search, title: 'Finding files' },
  grep: search,
  leaveThread,
  listThreads,
  ls: { title: 'Listing files' },
  mermaid,
  // Neutral: the plan shows that code work happened, not OpenCode's raw
  // report (long, and it names itself).
  // A failure says what failed (kyto's own error text, never the agent's
  // raw output): "Something went wrong" told nobody anything.
  opencode: {
    error: ({ output }) => ({ output: errorOutput(output) }),
    request: () => ({}),
    response: ({ output }) => ({
      output:
        value(output, 'success') === false
          ? `Didn't finish (exit ${String(value(output, 'exitCode') ?? '?')}).`
          : 'Done.',
    }),
    title: 'Working on the code',
  },
  postMessage: message,
  readConversationHistory: { ...fetchMessages, title: 'Reading history' },
  react: reaction,
  read: file,
  scheduleReminder,
  searchSlack,
  searchWeb,
  summarizeThread,
  uploadFile,
  write: { ...file, title: 'Writing file' },
};

const mcpTool: DefaultTaskRenderer = {
  error: () => ({
    output: "Failed. The server's error stays off this public card.",
  }),
  request: defaultTool.request,
  response: () => ({ output: 'Done.' }),
};

export function renderTask({
  input,
  output,
  phase,
  toolName,
}: {
  input: unknown;
  output?: unknown;
  phase: RenderPhase;
  toolName: string;
}) {
  // A family call (`reminders` with action `once`) renders as the verb it
  // stands for, so its card keeps the verb's own title and details.
  const verb = originalToolName({ input, toolName });
  const entry = renderers[verb];
  // An MCP tool reads whatever the server returns — a database password came
  // back from a "read" tool (#75) — and the plan is public. Its card says
  // that it ran, never what came back.
  const fallback = verb.startsWith('mcp_') ? mcpTool : defaultTool;
  const renderer =
    phase === 'error'
      ? (entry?.error ?? fallback.error)
      : (entry?.[phase] ?? fallback[phase]);
  const rendered = renderer({ input, output, toolName: verb });
  const title = entry?.title ?? rendered.title ?? verb;
  if (phase === 'request') {
    return {
      details: clamp(rendered.details, 96),
      title,
    };
  }
  return {
    output: clamp(
      phase === 'response' && !verb.startsWith('mcp_')
        ? (resultErrorOutput(output) ?? rendered.output)
        : rendered.output,
      96
    ),
    title,
  };
}
