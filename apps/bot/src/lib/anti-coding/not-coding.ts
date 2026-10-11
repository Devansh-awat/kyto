import { z } from 'zod';

// Commands that are never coding work, whatever the thread is about. Jev scores
// the WHOLE state — thread tail, the turn's earlier calls, then the call — so
// late in a long build turn the context outweighs a two-word command and it
// refused `echo alive`, `pwd` and `gh issue list` at 0.9+ (issues #21, #26).
// These skip Jev; anything less than certain falls through to it as before.
// This is a cost gate, not a security one: the GitHub write guard and the
// repo disarm still run inside each tool.
//
// PUBLISHING finished work is not coding either: Jev refused the owner's own
// "OPEN PR" (`git push`, 0.97) because the thread before it was a build, and
// kyto — told not to mention the catch — invented an approval it was waiting
// on. A push, a PR, an issue or a comment writes no code; the GitHub proxy
// still gates every one of them.

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
const GIT_PUBLISH = new Set(['push']);
const GIT_PUSH_RUNS = /^--(?:receive-pack|exec)(?:=|$)/;
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
const GH_PUBLISH: Record<string, Set<string>> = {
  issue: new Set(['comment', 'create']),
  pr: new Set(['comment', 'create']),
  repo: new Set(['fork']),
};
// What turns a publishing verb into an edit, a delete or a browser.
const GH_PUBLISH_UNSAFE_FLAGS = new Set([
  '--delete-last',
  '--edit-last',
  '--editor',
  '--web',
  '-e',
  '-w',
]);
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

// The wrapping a model puts around a one-liner: `cd dir && …` in front, and
// `2>&1 | tail -5` behind. Neither can make the command inside it code work, so
// it is peeled off before the command is judged. The directory is a plain path
// — no `~`, `$` or quotes — so `cd` can't run anything either.
const CD_PREFIX = /^cd\s+[\w./-]+\s*&&\s*/;
const OUTPUT_TAIL =
  /(?:\s+2>&1)?(?:\s*\|\s*(?:head|tail)(?:\s+-n)?(?:\s+-?\d+)?)?\s*$/;

function unwrap(command: string): string {
  return command.trim().replace(CD_PREFIX, '').replace(OUTPUT_TAIL, '');
}

function words(command: string): string[] | null {
  // An unclosed quote leaves characters no word covers.
  if (command.replace(WORD, '').trim() !== '') {
    return null;
  }
  return (command.match(WORD) ?? []).map((word) => word.replace(/['"]/g, ''));
}

function isNotCodingGh(args: string[]): boolean {
  const [group, verb] = args;
  if (!group) {
    return false;
  }
  if (verb !== undefined && GH_PUBLISH[group]?.has(verb)) {
    return !args.some((arg) =>
      GH_PUBLISH_UNSAFE_FLAGS.has(arg.split('=')[0] ?? arg)
    );
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

export function isNotCodingCall({
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
  const command = parsed.success ? unwrap(parsed.data.command) : '';
  if (!command || UNSAFE.test(command)) {
    return false;
  }
  const argv = words(command);
  const [head, ...args] = argv ?? [];
  // `FOO=bar cmd` could point a read-only tool at a different program.
  if (!head || head.includes('=')) {
    return false;
  }
  if (head === 'gh') {
    return isNotCodingGh(args);
  }
  if (head === 'git') {
    // `git -C dir …` is the same command run elsewhere; any other global flag
    // (`-c key=value`) could reconfigure what runs.
    const [sub, ...rest] = args[0] === '-C' ? args.slice(2) : args;
    if (sub !== undefined && GIT_PUBLISH.has(sub)) {
      // `--receive-pack`/`--exec` name a program to RUN for a local remote.
      return !rest.some((arg) => GIT_PUSH_RUNS.test(arg));
    }
    return (
      sub !== undefined &&
      GIT_READ.has(sub) &&
      !rest.some((arg) => GIT_WRITES.test(arg))
    );
  }
  return PLAIN.has(head);
}
