import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger, type Logger } from '@repo/logging/logger';
import { env } from '@/env';

// Which thread the code now running is working for. Set around a whole turn
// (lib/agent) so EVERY line logged inside it — agent, tools, sandbox, MCP —
// is tagged with the thread and captured for it, not just the few calls that
// remember to pass `threadId`. lib/thread-logs persists the capture.
export const threadLogContext = new AsyncLocalStorage<{ threadId: string }>();

const LEVELS: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};
// One line may carry a whole tool result; cap it so one call cannot fill a batch.
const MAX_LINE_CHARS = 4000;

const pending = new Map<string, string[]>();

function describe(obj: Record<string, unknown>): string {
  if (Object.keys(obj).length === 0) {
    return '';
  }
  try {
    return ` ${JSON.stringify(obj, (_key, value: unknown) =>
      value instanceof Error
        ? { message: value.message, name: value.name, stack: value.stack }
        : value
    )}`;
  } catch {
    return ' [unserializable fields]';
  }
}

/** Everything captured since the last call, by thread. */
export function takeThreadLogLines(): Map<string, string[]> {
  const taken = new Map(pending);
  pending.clear();
  return taken;
}

const logger: Logger = await createLogger({
  fileLogging: true,
  logDirectory: env.LOG_DIRECTORY,
  logLevel: env.LOG_LEVEL,
  mixin: () => {
    const context = threadLogContext.getStore();
    return context ? { threadId: context.threadId } : {};
  },
  onLog: ({ level, msg, obj }) => {
    const context = threadLogContext.getStore();
    if (!context) {
      return;
    }
    const line = `${new Date().toISOString()} ${LEVELS[level] ?? level} ${msg}${describe(obj)}`;
    const lines = pending.get(context.threadId) ?? [];
    lines.push(
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
    );
    pending.set(context.threadId, lines);
  },
});

export default logger;
