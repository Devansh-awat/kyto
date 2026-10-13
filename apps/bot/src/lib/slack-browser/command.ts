import { isSlackHost } from '@/lib/slack-web-proxy';
import { errorMessage } from '@/lib/utils/error';

/**
 * What the model may ask of the logged-in Slack browser. It runs on kyto's own
 * host, so an agent-browser sub-command that touches files (`upload`,
 * `screenshot <path>`, `state load`), fetches outside the browser (`read`,
 * `vitals <url>`), runs script (`eval`, `wait --fn`), relaunches the browser
 * with other flags, or wraps other commands (`batch`) would reach past the
 * browser into the box — `/app`, the container's environment, its network. So
 * the command is split into argv here (never handed to a shell) and only the
 * interaction verbs below pass, with navigation limited to https Slack URLs.
 */

const VERBS = new Set([
  'back',
  'check',
  'click',
  'console',
  'dblclick',
  'diff',
  'drag',
  'errors',
  'fill',
  'find',
  'focus',
  'forward',
  'get',
  'hover',
  'is',
  'keyboard',
  'mouse',
  'open',
  'press',
  'reload',
  'scroll',
  'scrollintoview',
  'select',
  'skills',
  'snapshot',
  'tab',
  'type',
  'uncheck',
  'wait',
]);

const GET_WHATS = new Set([
  'attr',
  'box',
  'count',
  'html',
  'styles',
  'text',
  'title',
  'url',
  'value',
]);

const FLAGS = new Set([
  '-c',
  '-d',
  '-i',
  '-s',
  '--clear',
  '--compact',
  '--depth',
  '--exact',
  '--full',
  '--interactive',
  '--load',
  '--name',
  '--selector',
  '--text',
  '--url',
]);

const FLAG = /^--?[a-z]/i;
const WORKSPACE_ID = /^[TE][A-Z0-9]+$/;

/** Shell-like split: quotes group words, a backslash escapes, nothing expands. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index);
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index++;
        current += command.charAt(index);
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < command.length) {
      index++;
      current += command.charAt(index);
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) {
    throw new Error('Unclosed quote in the command.');
  }
  if (started) {
    args.push(current);
  }
  return args;
}

function slackUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return;
  }
  try {
    const url = new URL(raw);
    if (!(url.protocol === 'https:' && isSlackHost(url.hostname))) {
      return `Only https Slack URLs can be opened, not ${raw}.`;
    }
    // A channel id where the workspace id belongs opens Slack's "There's been
    // a glitch" page, which the model then read as the browser being broken.
    const [section, workspace] = url.pathname.split('/').filter(Boolean);
    return url.hostname === 'app.slack.com' &&
      section === 'client' &&
      workspace &&
      !WORKSPACE_ID.test(workspace)
      ? `${workspace} is not a workspace id: the path is /client/<workspace T… or E… id>/<channel>; "thread" opens this conversation's thread.`
      : undefined;
  } catch {
    return `Only full https Slack URLs can be opened, not ${raw}.`;
  }
}

// No shell runs the command, so these reached agent-browser as arguments: the
// model kept piping `snapshot -i | grep …` and reading the garbage back.
const SHELL_OPERATORS = new Set(['|', '||', '&&', ';', '>', '>>', '<']);

/** A Slack client URL without its workspace id, which Slack rewrites (T… → E…). */
function pageKey(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, '');
    const client = /^\/client\/[^/]+(\/.*)?$/.exec(path);
    return url.hostname === 'app.slack.com' && client
      ? `client${client[1] ?? ''}${url.search}`
      : `${url.host}${path}${url.search}`;
  } catch {
    return;
  }
}

/**
 * Is `target` the page the browser is already on? Every `open` reboots the
 * whole Slack client (~5-10 s, the live view blanks), and the model re-opened
 * the same channel URL over and over to "refresh" it.
 */
export function isSamePage({
  current,
  target,
}: {
  current: string;
  target: string;
}): boolean {
  const key = pageKey(target);
  return key !== undefined && key === pageKey(current);
}

const CONVERSATION_ID = /^[CDG][A-Z0-9]{8,}$/;
const MESSAGE_TS = /^\d{10}\.\d{6}$/;
const THREAD_ID = /^slack:([CDG][A-Z0-9]{8,})(?::(\d{10}\.\d{6}))?$/;
const PERMALINK_PATH = /^\/archives\/([CDG][A-Z0-9]{8,})\/p(\d{10})(\d{6})\/?$/;

/** The web client's own URL for a conversation, or a thread in it. */
export function clientUrl({
  channel,
  team,
  threadTs,
}: {
  channel: string;
  team: string;
  threadTs?: string;
}): string {
  const base = `https://app.slack.com/client/${team}/${channel}`;
  return threadTs ? `${base}/thread/${channel}-${threadTs}` : base;
}

/**
 * `open C…`, `open C… 1791903295.656479`, `open slack:C…:<ts>` or
 * `open <message permalink>` as the
 * client URL, built here: a permalink goes through a "Redirecting…" page that
 * boots Slack twice, and a hand-written client URL once put a channel id where
 * the workspace id goes. A permalink opens its message's thread. Undefined when
 * `target` is none of those (a plain URL is opened as given).
 */
export function conversationUrl({
  target,
  team,
  threadTs,
}: {
  target: string;
  team: string;
  threadTs?: string;
}): string | undefined {
  if (CONVERSATION_ID.test(target)) {
    if (threadTs !== undefined && !MESSAGE_TS.test(threadTs)) {
      return;
    }
    return clientUrl({ channel: target, team, threadTs });
  }
  if (threadTs !== undefined) {
    return;
  }
  // kyto's own thread id, which the model passes straight from its tools.
  const own = THREAD_ID.exec(target);
  if (own) {
    return clientUrl({ channel: own[1] ?? '', team, threadTs: own[2] });
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return;
  }
  const permalink = PERMALINK_PATH.exec(url.pathname);
  if (!(url.protocol === 'https:' && isSlackHost(url.hostname) && permalink)) {
    return;
  }
  const [, channel = '', seconds, micros] = permalink;
  const replyTo = url.searchParams.get('thread_ts');
  return clientUrl({
    channel,
    team,
    threadTs:
      replyTo && MESSAGE_TS.test(replyTo) ? replyTo : `${seconds}.${micros}`,
  });
}

/** Why `args` may not run, or undefined when it may. */
function refusal(args: string[]): string | undefined {
  const [verb, first] = args;
  const operator = args.find((arg) => SHELL_OPERATORS.has(arg));
  if (operator) {
    return `There is no shell here, so "${operator}" doesn't work: run one command per call and read its output (a snapshot can be scoped with -s <css selector> or -d <depth>).`;
  }
  if (!(verb && VERBS.has(verb))) {
    return `"${verb ?? ''}" is not available in the Slack browser. Allowed: ${[...VERBS].join(', ')}.`;
  }
  const flag = args.find((arg) => FLAG.test(arg) && !FLAGS.has(arg));
  if (flag) {
    return `The ${flag} option is not available in the Slack browser.`;
  }
  switch (verb) {
    case 'open':
      return slackUrl(first) ?? (first ? undefined : 'open needs a URL.');
    case 'tab':
      if (first === 'new') {
        return slackUrl(args[2]);
      }
      return first === undefined ||
        first === 'list' ||
        first === 'close' ||
        /^\d+$/.test(first)
        ? undefined
        : 'tab supports: new [url], list, close [n], <n>.';
    case 'get':
      return first && GET_WHATS.has(first)
        ? undefined
        : `get supports: ${[...GET_WHATS].join(', ')}.`;
    case 'diff':
      return first === 'snapshot'
        ? undefined
        : 'Only diff snapshot is available.';
    case 'skills':
      return first === undefined || first === 'list' || first === 'get'
        ? undefined
        : 'Only skills list and skills get are available.';
    default:
      return;
  }
}

export type ParsedCommand =
  | { args: string[]; ok: true }
  | { error: string; ok: false };

// agent-browser's `wait` takes milliseconds or a selector: `wait 3s` waited 25 s
// for an element called "3s", and `wait 5` waited 5 ms.
const WAIT_SECONDS = /^(\d{1,3})s?$/;
const MAX_SECONDS_GUESS = 60;

function waitInMs(args: string[]): string[] {
  const [verb, amount] = args;
  const seconds = verb === 'wait' && amount ? WAIT_SECONDS.exec(amount) : null;
  if (!(seconds && args.length === 2)) {
    return args;
  }
  const value = Number(seconds[1]);
  return amount?.endsWith('s') || value <= MAX_SECONDS_GUESS
    ? ['wait', String(value * 1000)]
    : args;
}

export function parseCommand(command: string): ParsedCommand {
  let args: string[];
  try {
    args = waitInMs(splitCommand(command.trim()));
  } catch (error) {
    return { error: errorMessage(error), ok: false };
  }
  const error = refusal(args);
  return error ? { error, ok: false } : { args, ok: true };
}
