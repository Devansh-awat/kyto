import { z } from 'zod';

// Commands that are never coding work, whatever the thread is about. Jev scores
// the WHOLE state — thread tail, the turn's earlier calls, then the call — so
// late in a long build turn the context outweighs a two-word command and it
// refused `echo alive`, `pwd` and `gh issue list` at 0.9+ (issues #21, #26).
// These skip Jev; anything less than certain falls through to it as before.
// This is a cost gate, not a security one: the GitHub write guard and the
// repo disarm still run inside each tool.

const SHELL_TOOLS = new Set(['bash', 'gh', 'runBackgroundProcess']);

// Anything that could chain, redirect, substitute, glob or escape.
const UNSAFE = /[;&|<>`$(){}*?~!#\\\n\r\0[\]]/;

// Only quotes group words — UNSAFE has already ruled out every expansion.
const WORD = /(?:'[^']*'|"[^"]*"|[^\s'"])+/g;

const PLAIN = new Set([
  'basename',
  'cat',
  'date',
  'df',
  'dirname',
  'du',
  'echo',
  'false',
  'file',
  'head',
  'hostname',
  'ls',
  'nproc',
  'pwd',
  'stat',
  'tail',
  'true',
  'uname',
  'uptime',
  'wc',
  'which',
  'whoami',
]);

const GIT_READ = new Set(['diff', 'log', 'rev-parse', 'show', 'status']);
// `git diff --output=f` and `git log -o f` write a file.
const GIT_WRITES = /^(?:--output|-o)/;

const GH_READ: Record<string, Set<string>> = {
  gist: new Set(['list', 'view']),
  issue: new Set(['list', 'status', 'view']),
  label: new Set(['list']),
  pr: new Set(['checks', 'diff', 'list', 'status', 'view']),
  release: new Set(['list', 'view']),
  repo: new Set(['list', 'view']),
  run: new Set(['list', 'view']),
  search: new Set(['code', 'commits', 'issues', 'prs', 'repos']),
  workflow: new Set(['list', 'view']),
};
const GH_UNSAFE_FLAGS = new Set([
  '--body',
  '--clone',
  '--comment',
  '--delete',
  '--edit',
  '--web',
  '-w',
]);

// `gh api` is a GET unless it is given a method or a body.
const API_WRITES =
  /^(?:-X|--method|-f|-F|--field|--raw-field|--input|-H|--header|--hostname)(?:=|$)|^-[XfFH]./;
const API_ENDPOINT =
  /^\/?(?:repos|users|orgs|search|gists)\/|^\/?(?:user|rate_limit)$/;

const commandInput = z.object({ command: z.string() });

function words(command: string): string[] | null {
  // An unclosed quote leaves characters no word covers.
  if (command.replace(WORD, '').trim() !== '') {
    return null;
  }
  return (command.match(WORD) ?? []).map((word) => word.replace(/['"]/g, ''));
}

function isReadOnlyGh(args: string[]): boolean {
  const [group, verb] = args;
  if (!group) {
    return false;
  }
  if (group === 'status') {
    return args.length === 1;
  }
  if (group === 'api') {
    const rest = args.slice(1);
    const endpoint = rest.find((arg) => !arg.startsWith('-'));
    return (
      endpoint !== undefined &&
      API_ENDPOINT.test(endpoint) &&
      !rest.some((arg) => API_WRITES.test(arg))
    );
  }
  return (
    verb !== undefined &&
    GH_READ[group]?.has(verb) === true &&
    !args.some((arg) => GH_UNSAFE_FLAGS.has(arg.split('=')[0] ?? arg))
  );
}

export function isReadOnlyCall({
  input,
  toolName,
}: {
  input: unknown;
  toolName: string;
}): boolean {
  if (!SHELL_TOOLS.has(toolName)) {
    return false;
  }
  const parsed = commandInput.safeParse(input);
  if (!parsed.success || UNSAFE.test(parsed.data.command)) {
    return false;
  }
  const argv = words(parsed.data.command.trim());
  const [head, ...args] = argv ?? [];
  // `FOO=bar cmd` could point a read-only tool at a different program.
  if (!head || head.includes('=')) {
    return false;
  }
  if (head === 'gh') {
    return isReadOnlyGh(args);
  }
  if (head === 'git') {
    const [sub, ...rest] = args;
    return (
      sub !== undefined &&
      GIT_READ.has(sub) &&
      !rest.some((arg) => GIT_WRITES.test(arg))
    );
  }
  return PLAIN.has(head);
}
