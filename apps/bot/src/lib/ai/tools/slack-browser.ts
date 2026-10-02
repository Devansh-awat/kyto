import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness';
import { postLiveView } from '@/lib/browser/live-view-post';
import logger from '@/lib/logger';
import {
  type SlackBrowserSession,
  startSlackBrowser,
} from '@/lib/slack-browser';
import { parseCommand } from '@/lib/slack-browser/command';
import { errorMessage, toLogError } from '@/lib/utils/error';

// The owner's logged-in Slack browser (owner's ask, 2026-10-02): workflows,
// other apps' buttons, anything the Web API tools can't reach — as kyto's USER
// account. It runs on kyto's host, not in the sandbox (lib/slack-browser says
// why and how it is fenced), and neither half of the session is ever in it.

const MAX_OUTPUT_CHARS = 8000;
const RESTART = 'restart';

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

export function slackBrowserTool({
  asUserAccount,
  thread,
}: {
  /** Answering as kyto's user account (the live-view post's fallback sender). */
  asUserAccount: boolean;
  thread: ThreadHandle;
}) {
  let session: Promise<SlackBrowserSession> | undefined;

  const start = (): Promise<SlackBrowserSession> => {
    const started = startSlackBrowser().then(async (opened) => {
      // In the thread, like the plain browser's (owner's call, 2026-10-02) —
      // anyone there can watch kyto's Slack, DMs included, while it runs.
      await postLiveView({
        asUserAccount,
        thread,
        title: "watching kyto's Slack browser live",
        url: opened.viewUrl,
      }).catch((error: unknown) =>
        logger.warn(toLogError(error), '[slack-browser] live view post failed')
      );
      return opened;
    });
    // A failed start is retried by the next call, not cached.
    started.catch(() => {
      if (session === started) {
        session = undefined;
      }
    });
    return started;
  };

  const close = async (): Promise<void> => {
    const current = session;
    session = undefined;
    const opened = await current?.catch(() => undefined);
    await opened
      ?.close()
      .catch((error: unknown) =>
        logger.warn(toLogError(error), '[slack-browser] cleanup failed')
      );
  };

  const slackBrowser = tool({
    description: `Drive a real browser LOGGED IN to Slack as kyto's own user account (owner only) — for what the Slack tools can't do: running workflows, clicking buttons on other apps' messages or App Homes, forms, settings pages. Same agent-browser CLI as the \`browser\` tool (pass its sub-command in \`command\`; "skills get core" prints the reference), starting on https://app.slack.com/client. Only interaction commands work (open/click/fill/type/press/select/scroll/wait/snapshot/get/find/tab/…), and only Slack URLs open — no eval, screenshots, files or other sites. "${RESTART}" relaunches a stuck browser. Nothing in Slack is blocked except signing out: it can send, edit, react, join and run workflows AS kyto's user account, so act only on what the owner asked. A live view is posted in the thread on first use.`,
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Arguments for agent-browser, e.g. "snapshot -i", "open https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB", "click @e12", or "restart".'
        ),
    }),
    execute: async ({ command }, { abortSignal }) => {
      try {
        if (command.trim() === RESTART) {
          await close();
          session = start();
          await session;
          return {
            success: true,
            summary:
              'Restarted the Slack browser on https://app.slack.com/client.',
          };
        }
        const parsed = parseCommand(command);
        if (!parsed.ok) {
          return { error: parsed.error, success: false, summary: parsed.error };
        }
        session ??= start();
        const result = await (await session).run({
          abortSignal,
          args: parsed.args,
        });
        let summary = `Ran Slack browser ${command}.`;
        if (result.timedOut) {
          summary = `Slack browser ${command} took too long and was stopped; take a snapshot to see where the page is, or "${RESTART}" if the browser stopped answering.`;
        } else if (result.exitCode !== 0) {
          summary = `Slack browser ${command} exited ${result.exitCode}.`;
        }
        return {
          exitCode: result.exitCode,
          liveView:
            'A watch-only live view is already posted in the thread; no need to share it again.',
          stderr: truncate(result.stderr),
          stdout: truncate(result.stdout),
          success: result.exitCode === 0 && !result.timedOut,
          summary,
        };
      } catch (error) {
        return {
          error: errorMessage(error),
          success: false,
          summary: `Slack browser command failed: ${errorMessage(error)}`,
        };
      }
    },
  });

  return {
    /** End of turn: the browser, its proxy, its profile and the view all go. */
    close,
    tool: slackBrowser,
  };
}
