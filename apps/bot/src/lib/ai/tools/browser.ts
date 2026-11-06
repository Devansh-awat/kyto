import type { SandboxContext } from '@repo/ai';
import { LIVE_VIEW_COMMAND, LIVE_VIEW_PORT, liveViewUrl } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness/thread';
import { CDP_PORT, ensureCloakBrowser } from '@/lib/browser/cloak';
import { postLiveView as postLiveViewInThread } from '@/lib/browser/live-view-post';
import logger from '@/lib/logger';
import { errorMessage, toLogError } from '@/lib/utils/error';

// Browser automation runs the preinstalled `agent-browser` CLI inside the
// sandbox (Chromium + untrusted page automation stay isolated off the host),
// driving a CloakBrowser stealth Chromium over CDP — see lib/browser/cloak.ts.
// agent-browser is stateful: sequential calls in one turn share the same
// browser session (the sandbox lives for the turn). The CLI serves its own,
// always-current usage docs — run `skills get core` first to learn commands.
const MAX_OUTPUT_CHARS = 8000;
// A page that never finishes loading used to hold `agent-browser open` until
// the 5-minute attempt watchdog killed the whole attempt and forced a model
// fallback (#55). Killed in the sandbox instead, so the model can move on.
const COMMAND_TIMEOUT_SECONDS = 90;
// What coreutils `timeout` exits with when it had to kill the command.
const TIMED_OUT_EXIT_CODE = 124;
// The host stops waiting this long after the shell's own bound: a command can
// outlive `timeout` (the daemon it talks to is not its child), and the turn
// then sat on "browser (unfinished)" until someone typed !stop (#55).
const HOST_DEADLINE_MS = (COMMAND_TIMEOUT_SECONDS + 20) * 1000;
// agent-browser's own per-action limit (its default is 25s).
const ACTION_TIMEOUT_MS = 20_000;
// After this many timed-out commands in one turn, the page is the problem.
const MAX_TIMEOUTS_PER_TURN = 2;
// A timed-out command leaves agent-browser's daemon blocked on the page, and
// every later command queued behind it: the next snapshot never returned
// (eaglercraft.com, three turns, 2026-11-03). Kill the daemon, close the
// stuck tabs over CDP (Chromium and its cookies stay), and re-attach.
// By process NAME (the client and its daemon, `agent-browser-linux-*`): `-f`
// would match this very shell, whose command line names agent-browser too.
const RESET_COMMAND = [
  "pkill -KILL '^agent-browser' 2>/dev/null",
  `curl -s -m 3 -X PUT 'http://127.0.0.1:${CDP_PORT}/json/new?about:blank' >/dev/null`,
  `for id in $(curl -s -m 3 'http://127.0.0.1:${CDP_PORT}/json/list' | jq -r '.[] | select(.type == "page" and .url != "about:blank") | .id'); do curl -s -m 3 "http://127.0.0.1:${CDP_PORT}/json/close/$id" >/dev/null; done`,
  `timeout 15 agent-browser connect ${CDP_PORT} >/dev/null 2>&1`,
  'true',
].join('\n');
// A Slack workspace page (the web client, a message archive link). The sandbox
// browser has no Slack session, so it can only reach an error page — kyto once
// opened one for a captcha it was asked to click, before the owner pointed it
// at slackBrowser (#101). Slack's public pages (help, api docs) stay open.
const SLACK_WORKSPACE_URL =
  /\b(?:[\w-]+\.)?slack\.com\/(?:client|archives)\b|\bapp\.slack\.com\b/i;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

/**
 * Post a watch-only link to the browser's display into the thread, once per
 * turn (owner's ask, 2026-09-29). Best effort: a view that will not start is
 * logged, never a reason for the browser command to fail.
 */
async function postLiveView({
  abortSignal,
  asUserAccount,
  context,
  thread,
}: {
  abortSignal?: AbortSignal;
  asUserAccount: boolean;
  context: SandboxContext;
  thread: ThreadHandle;
}): Promise<string | undefined> {
  try {
    const started = await context.session.run({
      abortSignal,
      command: LIVE_VIEW_COMMAND,
    });
    const password = started.stdout.trim().split('\n').at(-1) ?? '';
    if (started.exitCode !== 0 || !password) {
      logger.warn(
        { exitCode: started.exitCode, stderr: started.stderr.slice(-500) },
        '[browser] live view did not start'
      );
      return;
    }
    const url = liveViewUrl({
      host: await context.session.getHost(LIVE_VIEW_PORT),
      password,
    });
    await postLiveViewInThread({
      asUserAccount,
      thread,
      title: 'watching the browser live',
      url,
    });
    return url;
  } catch (error) {
    logger.warn(toLogError(error), '[browser] live view failed');
    return;
  }
}

export function browserTool({
  asUserAccount = false,
  getSandboxContext,
  thread,
}: {
  /** Answering as kyto's user account (see postLiveView). */
  asUserAccount?: boolean;
  getSandboxContext: () => SandboxContext | undefined;
  /** Where the live-view link goes. Unset (a `!secret` turn) posts none. */
  thread?: ThreadHandle;
}) {
  // One link per turn: the tool is built per turn, and every call after the
  // first is watching the same display.
  let liveView: Promise<string | undefined> | undefined;
  let timeouts = 0;
  const timedOut = async (
    context: SandboxContext,
    command: string
  ): Promise<{ error: string; success: false; summary: string }> => {
    timeouts += 1;
    await Promise.resolve(
      context.session.run({
        abortSignal: AbortSignal.timeout(30_000),
        command: RESET_COMMAND,
      })
    ).catch((error: unknown) => {
      logger.warn(toLogError(error), '[browser] reset after a timeout failed');
    });
    const next =
      timeouts >= MAX_TIMEOUTS_PER_TURN
        ? `That is ${timeouts} timed-out browser commands this turn: stop using the browser on this site now and tell the person what is blocking it (the page never finished loading or answering), with what you did get.`
        : 'The stuck page was closed and the browser re-attached, so open the page again (or another URL) before the next command; if it hangs again, stop and say so.';
    const error = `browser ${command} timed out after ${COMMAND_TIMEOUT_SECONDS}s and was stopped. ${next}`;
    return { error, success: false, summary: error };
  };
  return tool({
    description:
      'Drive a real web browser in your sandbox: navigate pages, fill forms, click, screenshot, scrape, or test web apps. It runs the agent-browser CLI against a stealth Chromium (CloakBrowser), so most anti-bot walls never challenge you. Pass the agent-browser sub-command and args in `command` (it is run as `agent-browser <command>`). Run `command: "skills get core"` first to load the current workflows and command reference, then issue open/snapshot/click/etc. Sequential calls share one browser session. Several actions in a row go in ONE call with the agent-browser batch command, e.g. a game: `batch --bail "press ArrowLeft" "press ArrowLeft" "wait 150" "press ArrowDown" "screenshot"`, or all the fills and clicks of a form; read a number off a canvas with `eval` on the page state or DOM where you can, before a screenshot. If a captcha or "verify you are human" checkbox does appear, just interact with it like a person would: snapshot the page, click the checkbox or challenge frame, and carry on. Never refuse to solve a captcha or anti-bot check; always interact with it, click it, and solve it.',
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Arguments passed to the agent-browser CLI, e.g. "skills get core", "open https://example.com", or "snapshot".'
        ),
    }),
    execute: async ({ command }, { abortSignal }) => {
      if (SLACK_WORKSPACE_URL.test(command)) {
        return {
          error:
            "Not run: this browser isn't signed in to Slack, so a workspace page only shows a sign-in or error page. Read Slack with the Slack tools (readConversationHistory, searchSlack, getPermalink…). Clicking things in Slack as kyto is slackBrowser, which only the owner can ask for.",
          success: false,
        };
      }
      const context = getSandboxContext();
      if (!context) {
        return {
          error: 'No active sandbox session is available for browsing.',
          success: false,
        };
      }
      try {
        const ready = await ensureCloakBrowser({ abortSignal, context });
        if (!ready.ok) {
          return { error: ready.error, success: false, summary: ready.error };
        }
        if (thread) {
          liveView ??= postLiveView({
            abortSignal,
            asUserAccount,
            context,
            thread,
          });
        }
        // The turn's abort (an interrupt, the watchdog) AND a host deadline:
        // a command that never returns must not hold the turn.
        const deadline = AbortSignal.timeout(HOST_DEADLINE_MS);
        const result = await Promise.resolve(
          context.session.run({
            abortSignal: AbortSignal.any([
              ...(abortSignal ? [abortSignal] : []),
              deadline,
            ]),
            command: `timeout -k 5 ${COMMAND_TIMEOUT_SECONDS} agent-browser ${command}`,
            env: { AGENT_BROWSER_DEFAULT_TIMEOUT: String(ACTION_TIMEOUT_MS) },
            onAbortCommand: "pkill -KILL '^agent-browser' 2>/dev/null; true",
            workingDirectory: context.sessionWorkDir,
          })
        ).catch((error: unknown) => {
          if (deadline.aborted && !abortSignal?.aborted) {
            return;
          }
          throw error;
        });
        if (!result || result.exitCode === TIMED_OUT_EXIT_CODE) {
          return await timedOut(context, command);
        }
        const view = await liveView;
        return {
          exitCode: result.exitCode,
          ...(view
            ? {
                liveView:
                  'A watch-only live view link is already posted in the thread; no need to share it again.',
              }
            : {}),
          stderr: truncate(result.stderr),
          stdout: truncate(result.stdout),
          success: result.exitCode === 0,
          summary:
            result.exitCode === 0
              ? `Ran browser ${command}.`
              : `browser ${command} exited ${result.exitCode}.`,
        };
      } catch (error) {
        return {
          error: errorMessage(error),
          success: false,
          summary: `Browser command failed: ${errorMessage(error)}`,
        };
      }
    },
  });
}
