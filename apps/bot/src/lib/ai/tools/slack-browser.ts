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
// A form is a dozen clicks and fills: one call each cost glm ~4s of thinking
// per step (#98, 44 steps for one captcha form). Earlier steps of a batch keep
// only a head of their output, so a batch can't return ten snapshots in full.
const MAX_BATCH = 12;
const BATCH_STEP_OUTPUT_CHARS = 600;
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
// Slack draws every modal, popup and menu in a portal at the end of <body>,
// outside the thread pane — so a pane-scoped snapshot right after clicking a
// button that opened one showed only the now-disabled button, and kyto said
// "no popup" while the live view showed it (and its own next click hit it).
const MODAL = '.ReactModal__Content';
const MODAL_TEXT_CHARS = 4000;
const SCOPED = new Set(['-s', '--selector']);
const STALE_REF = /Unknown ref/i;

const WEDGED =
  /CDP command timed out|not responding|os error 11|daemon may be busy/i;
// An open dropdown or modal overlay over the target. Retried blind, the model
// pressed Escape — which in a Slack modal asks to discard the whole form.
const COVERED = /covered by (<[^>]+>)/i;
// Closes the top Slack modal by its own Close/Cancel button and prints its
// title (or "null" if there was none to close). Never Escape: in a form Slack
// asks whether to discard it, which is one more dialog on top.
const CLOSE_TOP_MODAL = `(() => {
  const modal = [...document.querySelectorAll('.ReactModal__Content')].at(-1);
  if (!modal) return null;
  const button = [...modal.querySelectorAll('button')].find((b) =>
    /^(close|cancel|dismiss|not now|no thanks)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())
  );
  if (!button) return null;
  const title = (modal.getAttribute('aria-label') || modal.textContent || '').trim().slice(0, 80);
  button.click();
  return title || 'untitled';
})()`;

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
  // How many elements match. Counted before any scoped snapshot because a
  // `snapshot -s` whose selector matches nothing drops EVERY ref the model was
  // handed: the modal check after each command did that whenever no modal was
  // open, and every click on a ref from the snapshot it had just read came back
  // "Unknown ref" (eleven times on one captcha).
  const countOf = async ({
    abortSignal,
    browser,
    selector,
  }: {
    abortSignal?: AbortSignal;
    browser: SlackBrowserSession;
    selector: string;
  }): Promise<number> => {
    const counted = await browser.run({
      abortSignal,
      args: ['get', 'count', selector],
    });
    const count = Number.parseInt(counted.stdout.trim(), 10);
    return counted.exitCode === 0 && Number.isFinite(count) ? count : 0;
  };
  const openModal = async ({
    abortSignal,
    browser,
  }: {
    abortSignal?: AbortSignal;
    browser: SlackBrowserSession;
  }): Promise<{ refs: string; text?: string } | undefined> => {
    if ((await countOf({ abortSignal, browser, selector: MODAL })) === 0) {
      return;
    }
    const found = await browser.run({
      abortSignal,
      args: ['snapshot', '-i', '-c', '-s', MODAL],
    });
    const refs = found.stdout.trim();
    if (
      found.exitCode !== 0 ||
      found.timedOut ||
      !refs ||
      refs === '(no interactive elements)'
    ) {
      return;
    }
    // A snapshot cuts each element's name at ~100 chars, which cut a form's
    // instructions mid-word ("…Tick pur") — kyto guessed which boxes to tick.
    const shown = await browser.run({
      abortSignal,
      args: ['get', 'text', MODAL],
    });
    const text = shown.exitCode === 0 ? shown.stdout.trim() : '';
    return {
      refs: truncate(refs),
      ...(text ? { text: text.slice(0, MODAL_TEXT_CHARS) } : {}),
    };
  };
  // Clears what covers a click's target and says what it did, or undefined
  // if there was nothing it could clear. A modal overlay means the target is
  // BEHIND the modal, so the modal is closed; anything else is a dropdown,
  // popover or sticky header — closed with Tab inside a modal (Escape would
  // ask to discard the form) or Escape outside one, then the target is
  // scrolled clear of it.
  const clearCover = async ({
    abortSignal,
    browser,
    cover,
    target,
  }: {
    abortSignal?: AbortSignal;
    browser: SlackBrowserSession;
    cover: string;
    target: string;
  }): Promise<string | undefined> => {
    if (cover.includes('ReactModal__Overlay')) {
      const closed = await browser.run({
        abortSignal,
        args: ['eval', CLOSE_TOP_MODAL],
      });
      const title = closed.stdout.trim().replace(/^"|"$/g, '');
      if (closed.exitCode !== 0 || !title || title === 'null') {
        return;
      }
      await browser.run({ abortSignal, args: ['wait', '500'] });
      return `closed the dialog that was on top of it ("${title}")`;
    }
    const inModal =
      (await countOf({ abortSignal, browser, selector: MODAL })) > 0;
    const key = inModal ? 'Tab' : 'Escape';
    await browser.run({ abortSignal, args: ['press', key] });
    await browser.run({ abortSignal, args: ['scrollintoview', target] });
    return `pressed ${key} and scrolled the target into view`;
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
    description: `Drive a real browser LOGGED IN to Slack as kyto's own user account (owner only). ONLY for what the Slack tools can't do: a last resort, never a shortcut: adding or removing a custom emoji is \`submitEmoji\`/\`removeEmoji\`, posting is \`postMessage\`, and so on; check the loadTools catalog first. It is for running workflows, clicking buttons on other apps' messages or App Homes (including verification buttons, "I'm not a robot" checks, anti-bot challenges, or captcha modals posted by other bots like Coolton), forms, settings pages. Same agent-browser CLI as the \`browser\` tool (pass its sub-command in \`command\`; "skills get core" prints the reference), starting IN the Slack thread this conversation is in (Slack's home for a DM with the app): a button or form someone posted as a REPLY here only shows in that thread pane, never in the channel view; "${THIS_THREAD}" goes back to it. For another conversation, \`open <channel id>\`, \`open <channel id> <thread ts>\`, \`open slack:C…:<ts>\` or \`open <message link>\` (opens that message's thread). Never hand-build an app.slack.com URL. Opening a thread returns \`threadPane\`: its messages, buttons and fields with refs: click a button by its ref. A modal, popup or menu Slack opens sits OUTSIDE the thread pane: while one is open every result carries it as \`modal\`: \`refs\` to act on and \`text\`, its FULL wording (a snapshot cuts labels at ~100 chars, so a form's instructions are read from \`modal.text\`). So check \`modal\` before saying nothing opened. Refs stay valid across snapshots until the element is redrawn; "Unknown ref" means take a fresh snapshot. A snapshot never shows formatting: after bolding or italicizing a rich-text box (select its text with Control+a, then the toolbar's Bold button or Control+b), check it with \`get html <ref>\` (look for <b>/<strong>) before submitting. After Submit, a form that stays open with "Please complete this required field." names the field in \`modal.text\`: fix that one, don't refill the rest. \`find text\` CLICKS the first match, which is often a message's words rather than the button; to look for something, read a \`snapshot\` (\`snapshot -i -c -s "${THREAD_PANE}"\` re-reads the thread). Slack's own dropdowns and date/time pickers are not native selects: \`select\` reports done and changes nothing: click the field, then click the option's ref; a value it doesn't list (4:30 PM in an hourly list) is TYPED into the field. An open dropdown covers the fields below it, so pick an option or press Tab before the next click. Never Escape inside a modal, which asks to discard the whole form. Every \`open\` reboots the whole Slack client (slow, the view blanks): after the first page, move by clicking (sidebar, a message's replies, the quick switcher on Control+k) and open a URL only to go somewhere a click can't reach. There is no shell, so no pipes; to run several commands in ONE call (filling a form: click, fill, select, then snapshot), put the first in \`command\` and the rest in \`next\`: they run in order, each checked the same way, and stop at the first that fails. \`diff snapshot\` returns only what changed since the last snapshot, far smaller than a fresh one. Only interaction commands work (open/click/fill/type/press/select/scroll/wait/snapshot/get/find/tab/eval/…), and only Slack URLs open. No screenshots, files or other sites. \`eval <js>\` runs JavaScript in the Slack page (reading a long list, checking state), and \`wait --fn <js>\` waits for a condition. "${RESTART}" relaunches a stuck browser. Nothing in Slack is blocked except signing out: it can send, edit, react, join and run workflows AS kyto's user account, so act only on what the owner asked. A live view is posted in the thread on first use.`,
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Arguments for agent-browser, e.g. "snapshot -i", "open https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB", "click @e12", or "restart".'
        ),
      next: z
        .array(z.string().min(1))
        .max(MAX_BATCH)
        .optional()
        .describe(
          `More commands to run right after \`command\`, in order, in this same call (at most ${MAX_BATCH}), e.g. ["fill @e4 Lily", "click @e7", "diff snapshot"]. Stops at the first one that fails; only the last one's output comes back in full.`
        ),
    }),
    execute: async ({ command: first, next = [] }, { abortSignal }) => {
      // Every command of a batch goes through runOne, so through parseCommand's
      // allowlist — unlike agent-browser's own \`batch\`, which stays refused
      // because it would hand its inner commands to the browser unchecked.
      const steps = [first, ...next];
      const results: Awaited<ReturnType<typeof runOne>>[] = [];
      for (const step of steps) {
        const result = await runOne({ abortSignal, requested: step });
        results.push(result);
        if (!result.success) {
          break;
        }
      }
      const last = results.at(-1);
      if (steps.length === 1 || !last) {
        return last;
      }
      const skipped = steps.length - results.length;
      return {
        ...last,
        steps: results.slice(0, -1).map((result, index) => ({
          command: steps[index],
          success: result.success,
          summary: result.summary,
          ...('stdout' in result && result.stdout
            ? { stdout: result.stdout.slice(0, BATCH_STEP_OUTPUT_CHARS) }
            : {}),
        })),
        summary: `${skipped > 0 ? `Stopped at step ${results.length} of ${steps.length} (the rest did not run): ` : `Ran all ${steps.length} commands; the last: `}${last.summary}`,
      };
    },
  });

  const runOne = async ({
    abortSignal,
    requested,
  }: {
    abortSignal?: AbortSignal;
    requested: string;
  }) => {
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
            summary: `Already on ${target}. Not reloaded (an open reboots all of Slack).`,
            ...(target.includes('/thread/')
              ? { threadPane: await threadPane({ abortSignal, browser }) }
              : {}),
          };
        }
      }
      const scope =
        verb === 'snapshot'
          ? parsed.args[parsed.args.findIndex((arg) => SCOPED.has(arg)) + 1]
          : undefined;
      if (
        scope &&
        parsed.args.some((arg) => SCOPED.has(arg)) &&
        (await countOf({ abortSignal, browser, selector: scope })) === 0
      ) {
        return {
          success: false,
          summary: `Nothing on the page matches ${scope}, so the snapshot was not taken: the refs from your earlier snapshots still work. Take an unscoped \`snapshot -i -c\` to see what is there.`,
        };
      }
      let result = await browser.run({
        abortSignal,
        args: parsed.args,
      });
      // Something on top of the target (#101). Told to clear it itself, the
      // model ended the turn instead ("the second ping hasn't gone through"),
      // so it is cleared here and the command retried once.
      const cover = COVERED.exec(result.stderr)?.[1];
      const cleared =
        cover && target
          ? await clearCover({ abortSignal, browser, cover, target })
          : undefined;
      if (cleared) {
        result = await browser.run({ abortSignal, args: parsed.args });
      }
      let summary = `Ran Slack browser ${command}${cleared ? ` after it ${cleared}` : ''}.`;
      if (result.timedOut) {
        summary = `Slack browser ${command} took too long and was stopped; take a snapshot to see where the page is, or "${RESTART}" if the browser stopped answering.`;
      } else if (WEDGED.test(result.stderr)) {
        // A hung tab fails fast like this on EVERY later command too, so
        // without the hint the model kept retrying a dead browser.
        summary = `Slack browser ${command} failed: the browser stopped answering. Run "${RESTART}" before trying again.`;
      } else if (COVERED.test(result.stderr)) {
        summary = `Slack browser ${command} hit something on top of the target (${COVERED.exec(result.stderr)?.[1]})${cleared ? `, even after it ${cleared}` : ''}. Take a snapshot to see what is covering it, close that by its own button, then try again (never Escape in a modal: it asks to discard the form).`;
      } else if (STALE_REF.test(result.stderr)) {
        summary = `Slack browser ${command} failed: that ref is gone: the element was redrawn, or the page changed. Take a fresh snapshot and use the refs it gives.`;
      } else if (result.exitCode !== 0) {
        summary = `Slack browser ${command} exited ${result.exitCode}.`;
      } else if (
        verb === 'snapshot' &&
        result.stdout.trim() === '(no interactive elements)'
      ) {
        // Slack's client is still booting. Read as a dead page, this sent
        // the model to `open` the channel again, which reboots it again.
        summary =
          'Slack is still loading (nothing on the page yet): "wait 3000", then snapshot again. Do not open the URL again: that restarts the load.';
      }
      // A whole-page snapshot already holds the modal's refs, so it gets only
      // the full wording; anything else, scoped snapshots included, gets both.
      const found = result.timedOut
        ? undefined
        : await openModal({ abortSignal, browser });
      const wholePage =
        verb === 'snapshot' && !parsed.args.some((arg) => SCOPED.has(arg));
      let modal: { refs?: string; text?: string } | undefined = found;
      if (found && wholePage) {
        modal = found.text ? { text: found.text } : undefined;
      }
      if (modal) {
        summary += wholePage
          ? ' A modal or popup is open; its refs are in this snapshot and `modal.text` has its full wording: a snapshot cuts long labels, so read the instructions there.'
          : ' A modal or popup is OPEN on top of Slack (`modal.refs` to act on, `modal.text` with its full wording; read the instructions there, a snapshot cuts long labels). Act on it there; it is not inside the thread pane.';
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
        ...(modal ? { modal } : {}),
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
  };

  return {
    /** End of turn: the browser, its proxy, its profile and the view all go. */
    close,
    tool: slackBrowser,
  };
}
