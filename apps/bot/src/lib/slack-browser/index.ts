import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { env } from '@/env';
import logger from '@/lib/logger';
import { slackWebConfigured, startSlackWebProxy } from '@/lib/slack-web-proxy';
import { errorMessage } from '@/lib/utils/error';
import { registerLiveView, SLACK_VIEW_PREFIX } from './live-view';

/**
 * The owner's logged-in Slack browser, on kyto's own host (owner's call,
 * 2026-10-02). It first ran in the E2B sandbox, where Slack's page alone
 * (~740 MB) did not fit beside the rest in a 1 GB box: the sidebar drew, the
 * messages never did, and the tab stopped answering.
 *
 * On the host it must not reach the host. Chromium's resolver is the fence:
 * `*.slack.com` goes to this session's loopback proxy (lib/slack-web-proxy,
 * which holds the session), Slack's CDNs resolve normally, and EVERY other
 * name — IP literals and `localhost` included — fails to resolve, so a link or
 * a page can't reach Coolify, another container or the metadata
 * address. What the model can ask for is fenced separately (./command).
 */

const START_TIMEOUT_MS = 20_000;
const POLL_MS = 100;
const COMMAND_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 10_000;
const WINDOW_SIZE = '1440,900';
const START_URL = 'https://app.slack.com/client';

// Hosts that load directly: Slack's static assets, image proxy and telemetry.
const DIRECT_HOSTS = ['slack-edge.com', 'slack-imgs.com', 'slackb.com'];

function chromiumPath(): string | null {
  return Bun.which('chromium') ?? Bun.which('chromium-browser');
}

export function slackBrowserAvailable(): boolean {
  return Boolean(
    env.SITES_ENABLED && slackWebConfigured() && chromiumPath() !== null
  );
}

/** Chromium's `--host-resolver-rules`: Slack to the proxy, CDNs out, the rest nowhere. */
export function resolverRules(proxyPort: number): string {
  return [
    ...DIRECT_HOSTS.flatMap((host) => [`EXCLUDE ${host}`, `EXCLUDE *.${host}`]),
    `MAP slack.com 127.0.0.1:${proxyPort}`,
    `MAP *.slack.com 127.0.0.1:${proxyPort}`,
    'MAP * ~NOTFOUND',
  ].join(', ');
}

function agentBrowserPath(): string {
  const packageDir = nodePath.dirname(
    Bun.resolveSync('agent-browser/package.json', import.meta.dir)
  );
  return nodePath.join(
    packageDir,
    'bin',
    `agent-browser-${process.platform}-${process.arch}`
  );
}

/** Nothing of kyto's environment goes to the browser or the CLI. */
function childEnv(home: string): Record<string, string> {
  return { HOME: home, LANG: 'en_US.UTF-8', PATH: process.env.PATH ?? '' };
}

async function waitForDevtoolsPort(profileDir: string): Promise<number> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const content = await readFile(
      nodePath.join(profileDir, 'DevToolsActivePort'),
      'utf8'
    ).catch(() => '');
    const port = Number.parseInt(content.split('\n')[0] ?? '', 10);
    if (port > 0) {
      return port;
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error('Chromium did not open its debugging port in time.');
}

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface SlackBrowserSession {
  close: () => Promise<void>;
  run: (options: {
    abortSignal?: AbortSignal;
    args: string[];
  }) => Promise<CommandResult>;
  viewUrl: string;
}

export async function startSlackBrowser(): Promise<SlackBrowserSession> {
  const chromium = chromiumPath();
  if (!chromium) {
    throw new Error('Chromium is not installed on this host.');
  }
  const stateDir = await mkdtemp(nodePath.join(tmpdir(), 'kyto-slack-'));
  const profileDir = nodePath.join(stateDir, 'profile');
  const proxy = await startSlackWebProxy();
  const browser = Bun.spawn(
    [
      chromium,
      '--headless=new',
      // The container runs as root, where Chromium's sandbox can't start;
      // the resolver fence above is what contains it.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-component-update',
      '--disable-extensions',
      '--disable-sync',
      '--no-proxy-server',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      `--window-size=${WINDOW_SIZE}`,
      `--host-resolver-rules=${resolverRules(proxy.port)}`,
      `--ignore-certificate-errors-spki-list=${proxy.spki}`,
      START_URL,
    ],
    { env: childEnv(stateDir), stderr: 'ignore', stdout: 'ignore' }
  );

  let cdpPort: number;
  try {
    cdpPort = await waitForDevtoolsPort(profileDir);
  } catch (error) {
    browser.kill('SIGKILL');
    proxy.stop();
    await rm(stateDir, { force: true, recursive: true });
    throw error;
  }
  const view = registerLiveView(cdpPort);
  const agentBrowser = agentBrowserPath();
  const session = `kyto-slack-${nodePath.basename(stateDir)}`;

  const run = async ({
    abortSignal,
    args,
    timeoutMs = COMMAND_TIMEOUT_MS,
  }: {
    abortSignal?: AbortSignal;
    args: string[];
    timeoutMs?: number;
  }): Promise<CommandResult> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const child = Bun.spawn(
      [agentBrowser, '--session', session, '--cdp', String(cdpPort), ...args],
      {
        cwd: stateDir,
        env: childEnv(stateDir),
        signal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout,
        stderr: 'pipe',
        stdout: 'pipe',
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr, stdout, timedOut: timeout.aborted };
  };

  return {
    /**
     * End of the turn: the view link dies first, then the browser, its proxy
     * and its profile — the web client caches messages in IndexedDB — so a
     * later turn, maybe someone else's, finds none of it.
     */
    close: async () => {
      view.end();
      await run({ args: ['close'], timeoutMs: CLOSE_TIMEOUT_MS }).catch(
        (error: unknown) =>
          logger.warn(
            { error: errorMessage(error) },
            '[slack-browser] agent-browser close failed'
          )
      );
      browser.kill();
      const exited = await Promise.race([
        browser.exited.then(() => true),
        Bun.sleep(CLOSE_TIMEOUT_MS).then(() => false),
      ]);
      if (!exited) {
        browser.kill('SIGKILL');
      }
      proxy.stop();
      await rm(stateDir, { force: true, recursive: true });
    },
    run,
    viewUrl: `https://${env.SITES_PUBLIC_HOST}${SLACK_VIEW_PREFIX}${view.id}`,
  };
}
