import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness/thread';
import { postLiveView } from '@/lib/browser/live-view-post';
import logger from '@/lib/logger';
import {
  type SlackBrowserSession,
  startSlackBrowser,
} from '@/lib/slack-browser';
import {
  clientUrl,
  conversationUrl,
  isSamePage,
  parseCommand,
  splitCommand,
} from '@/lib/slack-browser/command';
import { errorMessage, toLogError } from '@/lib/utils/error';

// The owner's logged-in Slack browser (owner's ask, 2026-10-02): workflows,
// other apps' buttons, anything the Web API tools can't reach — as kyto's USER
// account. It runs on kyto's host, not in the sandbox (lib/slack-browser says
// why and how it is fenced), and neither half of the session is ever in it.

const MAX_OUTPUT_CHARS = 8000;
const RESTART = 'restart';
const THIS_THREAD = 'thread';

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

// Slack's thread pane. agent-browser's `wait <selector>` holds until it is
// drawn, so the model's first look is at a loaded thread, not an empty shell.
const THREAD_PANE = "[aria-label^='Thread in']";
const PANE_WAIT_MS = 20_000;

const WEDGED =
  /CDP command timed out|not responding|os error 11|daemon may be busy/i;

export function slackBrowserTool({
  asUserAccount,
  thread,
}: {
  /** Answering as kyto's user account (the live-view post's fallback sender). */
  asUserAccount: boolean;
  thread: ThreadHandle;
}) {
  let session: Promise<SlackBrowserSession> | undefined;
  let paneAwaited = false;

  // The open thread's buttons and fields with their refs. Without it glm spent
  // ~10 minutes and dozens of calls finding a button that was in the thread:
  // whole-page snapshots taken mid-load came back empty, guessed CSS selectors
  // missed, and `find text` clicked the message's words ("click i'm not a
  // robot") instead of the button under them.
  const threadPane = async ({
    abortSignal,
    browser,
  }: {
    abortSignal?: AbortSignal;
    browser: SlackBrowserSession;
  }): Promise<string | undefined> => {
    const ready = await browser.run({
      abortSignal,
      args: ['wait', THREAD_PANE],
      timeoutMs: PANE_WAIT_MS,
    });
    if (ready.exitCode !== 0 || ready.timedOut) {
      return;
    }
    const pane = await browser.run({
      abortSignal,
      args: ['snapshot', '-i', '-c', '-s', THREAD_PANE],
    });
    return pane.exitCode === 0 ? truncate(pane.stdout) : undefined;
  };
  // Built here, not by the model: it glued a channel id where the workspace id
  // goes and landed on Slack's "There's been a glitch" page.
  const team = thread.adapter.teamId ?? '';
  const here = thread.adapter.decodeThreadId(thread.id);
  // It starts in the thread it was asked from (owner's ask, 2026-10-13) — the
  // button it is usually there for is a reply in it. Not in the APP's DM:
  // kyto's user account isn't in that conversation, so it opens Slack's home.
  const startUrl =
    team && (asUserAccount || !here.channel.startsWith('D'))
      ? clientUrl({ ...here, team })
      : undefined;

  const start = (): Promise<SlackBrowserSession> => {
    const started = startSlackBrowser({ startUrl }).then(async (opened) => {
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
    description: `Drive a real browser LOGGED IN to Slack as kyto's own user account (owner only) — ONLY for what the Slack tools can't do — a last resort, never a shortcut: adding or removing a custom emoji is \`submitEmoji\`/\`removeEmoji\`, posting is \`postMessage\`, and so on; check the loadTools catalog first. It is for running workflows, clicking buttons on other apps' messages or App Homes, forms, settings pages. Same agent-browser CLI as the \`browser\` tool (pass its sub-command in \`command\`; "skills get core" prints the reference), starting IN the Slack thread this conversation is in (Slack's home for a DM with the app) — a button or form someone posted as a REPLY here only shows in that thread pane, never in the channel view; "${THIS_THREAD}" goes back to it. For another conversation, \`open <channel id>\`, \`open <channel id> <thread ts>\`, \`open slack:C…:<ts>\` or \`open <message link>\` (opens that message's thread) — never hand-build an app.slack.com URL. Opening a thread returns \`threadPane\`: its messages, buttons and fields with refs — click a button by its ref. \`find text\` CLICKS the first match, which is often a message's words rather than the button; to look for something, read a \`snapshot\` (\`snapshot -i -c -s "${THREAD_PANE}"\` re-reads the thread). Slack's own dropdowns and date/time pickers are not native selects — \`select\` reports done and changes nothing: click the field, then click the option's ref; a value it doesn't list (4:30 PM in an hourly list) is TYPED into the field. An open dropdown covers the fields below it, so pick an option or press Tab before the next click — never Escape inside a modal, which asks to discard the whole form. Every \`open\` reboots the whole Slack client (slow, the view blanks): after the first page, move by clicking (sidebar, a message's replies, the quick switcher on Control+k) and open a URL only to go somewhere a click can't reach. One command per call — there is no shell, so no pipes. Only interaction commands work (open/click/fill/type/press/select/scroll/wait/snapshot/get/find/tab/…), and only Slack URLs open — no eval, screenshots, files or other sites. "${RESTART}" relaunches a stuck browser. Nothing in Slack is blocked except signing out: it can send, edit, react, join and run workflows AS kyto's user account, so act only on what the owner asked. A live view is posted in the thread on first use.`,
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Arguments for agent-browser, e.g. "snapshot -i", "open https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB", "click @e12", or "restart".'
        ),
    }),
    execute: async ({ command: requested }, { abortSignal }) => {
      let command = requested.trim();
      if (command === THIS_THREAD) {
        command = `open ${clientUrl({ ...here, team })}`;
      } else if (command.startsWith('open ')) {
        let words: string[] = [];
        try {
          words = splitCommand(command);
        } catch {
          // An unclosed quote: parseCommand below says so.
        }
        const [, target, threadTs, ...extra] = words;
        const url =
          target && extra.length === 0
            ? conversationUrl({ target, team, threadTs })
            : undefined;
        command = url ? `open ${url}` : command;
      }
      try {
        if (command === RESTART) {
          await close();
          session = start();
          await session;
          return {
            success: true,
            summary: `Restarted the Slack browser ${startUrl ? "in this conversation's thread" : "on Slack's home"}.`,
          };
        }
        const parsed = parseCommand(command);
        if (!parsed.ok) {
          return { error: parsed.error, success: false, summary: parsed.error };
        }
        session ??= start();
        const browser = await session;
        const [verb, target] = parsed.args;
        if (!paneAwaited && startUrl?.includes('/thread/')) {
          paneAwaited = true;
          await threadPane({ abortSignal, browser });
        }
        if (verb === 'open' && target) {
          const at = await browser.run({ abortSignal, args: ['get', 'url'] });
          if (
            at.exitCode === 0 &&
            isSamePage({ current: at.stdout.trim(), target })
          ) {
            return {
              success: true,
              summary: `Already on ${target} — not reloaded (an open reboots all of Slack).`,
              ...(target.includes('/thread/')
                ? { threadPane: await threadPane({ abortSignal, browser }) }
                : {}),
            };
          }
        }
        const result = await browser.run({
          abortSignal,
          args: parsed.args,
        });
        let summary = `Ran Slack browser ${command}.`;
        if (result.timedOut) {
          summary = `Slack browser ${command} took too long and was stopped; take a snapshot to see where the page is, or "${RESTART}" if the browser stopped answering.`;
        } else if (WEDGED.test(result.stderr)) {
          // A hung tab fails fast like this on EVERY later command too, so
          // without the hint the model kept retrying a dead browser.
          summary = `Slack browser ${command} failed: the browser stopped answering. Run "${RESTART}" before trying again.`;
        } else if (result.exitCode !== 0) {
          summary = `Slack browser ${command} exited ${result.exitCode}.`;
        } else if (
          verb === 'snapshot' &&
          result.stdout.trim() === '(no interactive elements)'
        ) {
          // Slack's client is still booting. Read as a dead page, this sent
          // the model to `open` the channel again, which reboots it again.
          summary =
            'Slack is still loading (nothing on the page yet): "wait 3000", then snapshot again. Do not open the URL again — that restarts the load.';
        }
        const opensThread =
          verb === 'open' &&
          target?.includes('/thread/') &&
          result.exitCode === 0 &&
          !result.timedOut;
        return {
          exitCode: result.exitCode,
          ...(opensThread
            ? { threadPane: await threadPane({ abortSignal, browser }) }
            : {}),
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
