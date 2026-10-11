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

// Outside quotes: anything that could chain, redirect, substitute, glob or
// escape. `&&`, a `| tail` and `2>&1` are recognised before this is applied.
const UNSAFE = /[;&|<>`$(){}*?~!#\\\n\r\0[\]]/;
// Read a double-quoted string the way bash does: `\` escapes the next
// character (a PR body's markdown is full of \`code\`), and an unescaped `$` or
// backtick still expands, so it is refused. Returns the text and where it ends.
function readDoubleQuoted(
  command: string,
  open: number
): { end: number; text: string } | null {
  let text = '';
  let i = open + 1;
  while (i < command.length) {
    const char = command[i];
    if (char === '"') {
      return { end: i + 1, text };
    }
    if (char === '$' || char === '`') {
      return null;
    }
    if (char === '\\') {
      text += command[i + 1] ?? '';
      i += 2;
    } else {
      text += char;
      i += 1;
    }
  }
  return null;
}

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
// `git branch NAME` creates one, so only its listing flags count as reading.
const GIT_BRANCH_LISTS = new Set([
  '--all',
  '--list',
  '--remotes',
  '--show-current',
  '--verbose',
  '-a',
  '-r',
  '-v',
  '-vv',
]);
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

type Token = { op: '&&' | '|' | '2>&1' } | { word: string };

// A shell line as words and the three operators a model wraps a one-liner in:
// `cd dir && …`, `… && …`, and `2>&1 | tail -5`. Null for anything else outside
// quotes. Quoted text is only text — a PR body with "(" in it is still a PR —
// except what double quotes still expand.
function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let word: string | undefined;
  const endWord = () => {
    if (word !== undefined) {
      tokens.push({ word });
      word = undefined;
    }
  };
  let i = 0;
  while (i < command.length) {
    const char = command[i] ?? '';
    if (char === ' ' || char === '\t') {
      endWord();
      i += 1;
    } else if (command.startsWith('&&', i)) {
      endWord();
      tokens.push({ op: '&&' });
      i += 2;
    } else if (char === '|' && command[i + 1] !== '|') {
      endWord();
      tokens.push({ op: '|' });
      i += 1;
    } else if (word === undefined && command.startsWith('2>&1', i)) {
      tokens.push({ op: '2>&1' });
      i += 4;
    } else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) {
        return null;
      }
      word = (word ?? '') + command.slice(i + 1, close);
      i = close + 1;
    } else if (char === '"') {
      const quoted = readDoubleQuoted(command, i);
      if (!quoted) {
        return null;
      }
      word = (word ?? '') + quoted.text;
      i = quoted.end;
    } else if (UNSAFE.test(char)) {
      return null;
    } else {
      word = (word ?? '') + char;
      i += 1;
    }
  }
  endWord();
  return tokens;
}

const TAIL_COUNT = /^-?\d+$/;
const CD_PATH = /^[\w./-]+$/;

// One `&&`-separated command's words, with a trailing `2>&1 | tail -N` peeled
// off (it can't make the command code work). Null if any other operator is in it.
function segmentArgv(tokens: Token[]): string[] | null {
  let rest = tokens;
  const pipe = rest.findIndex((token) => 'op' in token && token.op === '|');
  if (pipe !== -1) {
    const filter = rest
      .slice(pipe + 1)
      .map((token) => ('word' in token ? token.word : null));
    const [name, ...args] = filter;
    const count = args[0] === '-n' ? args.slice(1) : args;
    if (
      (name !== 'head' && name !== 'tail') ||
      count.length > 1 ||
      (count[0] !== undefined && !TAIL_COUNT.test(count[0] ?? ''))
    ) {
      return null;
    }
    rest = rest.slice(0, pipe);
  }
  const last = rest.at(-1);
  if (last && 'op' in last && last.op === '2>&1') {
    rest = rest.slice(0, -1);
  }
  const argv: string[] = [];
  for (const token of rest) {
    if (!('word' in token)) {
      return null;
    }
    argv.push(token.word);
  }
  return argv;
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

function isNotCodingArgv([head, ...args]: string[]): boolean {
  // `FOO=bar cmd` could point a read-only tool at a different program.
  if (!head || head.includes('=')) {
    return false;
  }
  if (head === 'cd') {
    return args.length === 1 && CD_PATH.test(args[0] ?? '');
  }
  if (head === 'gh') {
    return isNotCodingGh(args);
  }
  if (head === 'git') {
    // `git -C dir …` is the same command run elsewhere; any other global flag
    // (`-c key=value`) could reconfigure what runs.
    const [sub, ...rest] = args[0] === '-C' ? args.slice(2) : args;
    if (sub === 'branch') {
      return rest.every((arg) => GIT_BRANCH_LISTS.has(arg));
    }
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

// Every command in a `&&` chain must be one on its own: the owner's "do it"
// on a finished PR was refused at 0.96 because kyto ran
// `git push … 2>&1 | tail -5 && gh pr create …` as one call, and each half
// alone would have skipped Jev (2026-10-11).
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
  const tokens = parsed.success ? tokenize(parsed.data.command.trim()) : null;
  if (!tokens || tokens.length === 0) {
    return false;
  }
  const segments: Token[][] = [[]];
  for (const token of tokens) {
    if ('op' in token && token.op === '&&') {
      segments.push([]);
    } else {
      segments.at(-1)?.push(token);
    }
  }
  return segments.every((segment) => {
    const argv = segmentArgv(segment);
    return argv !== null && isNotCodingArgv(argv);
  });
}
