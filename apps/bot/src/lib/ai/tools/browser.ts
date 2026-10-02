import type { SandboxContext } from '@repo/ai';
import { LIVE_VIEW_COMMAND, LIVE_VIEW_PORT, liveViewUrl } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness';
import { ensureCloakBrowser } from '@/lib/browser/cloak';
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
  return tool({
    description:
      'Drive a real web browser in your sandbox: navigate pages, fill forms, click, screenshot, scrape, or test web apps. It runs the agent-browser CLI against a stealth Chromium (CloakBrowser), so most anti-bot walls never challenge you. Pass the agent-browser sub-command and args in `command` (it is run as `agent-browser <command>`). Run `command: "skills get core"` first to load the current workflows and command reference, then issue open/snapshot/click/etc. Sequential calls share one browser session. If a captcha or "verify you are human" checkbox does appear, just interact with it like a person would — snapshot the page, click the checkbox or challenge frame, and carry on. Never tell the user you cannot get past a captcha before you have actually tried clicking it.',
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Arguments passed to the agent-browser CLI, e.g. "skills get core", "open https://example.com", or "snapshot".'
        ),
    }),
    execute: async ({ command }, { abortSignal }) => {
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
        // Forward the turn's abort signal so a browser command that never
        // returns (a page that hangs loading) is killed when the turn is
        // interrupted or the per-attempt watchdog fires — otherwise the agent
        // loop stays blocked awaiting this tool and the whole turn freezes.
        const result = await context.session.run({
          abortSignal,
          command: `agent-browser ${command}`,
          workingDirectory: context.sessionWorkDir,
        });
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
