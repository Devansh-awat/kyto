import { z } from 'zod';
import { withGhPrefixes } from '@/lib/ai/tools/gh-prefix';

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

// Outside quotes: anything that could chain, redirect, substitute or escape.
// `&&`, `||`, `;`, pipes, `$NAME`, `2>&1` and a redirect to /dev/null are
// recognised before this is applied. Globs (`*.ts`, `~`) are only file names
// to a command that reads, so they pass (#26: this is a cost gate).
const UNSAFE = /[;&|<>`$(){}!#\\\n\r\0]/;
// `$HOME`, `${f}`: a variable is a value, not a command. `$(…)` still isn't.
const VARIABLE = /^\$(?:\{\w+\}|[A-Za-z_]\w*)/;
// Output thrown away or merged changes nothing a command does.
const NULL_REDIRECT =
  /^(?:[012]?>>?|&>>?|<)\s*\/dev\/null(?=[\s;&|]|$)|^[12]?>&[12](?=[\s;&|]|$)/;
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
    if (char === '$') {
      const variable = VARIABLE.exec(command.slice(i));
      if (!variable) {
        return null;
      }
      text += variable[0];
      i += variable[0].length;
      continue;
    }
    if (char === '`') {
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
  '[',
  'ag',
  'arch',
  'b2sum',
  'base64',
  'basename',
  'cat',
  'cmp',
  'column',
  'comm',
  'cut',
  'diff',
  'dig',
  'fd',
  'fdfind',
  'fold',
  'host',
  'hexdump',
  'jq',
  'less',
  'locale',
  'lsof',
  'lspci',
  'lsusb',
  'more',
  'nl',
  'nm',
  'nslookup',
  'objdump',
  'od',
  'printenv',
  'printf',
  'readelf',
  'rev',
  'rg',
  'sleep',
  'sort',
  'ss',
  'strings',
  'tac',
  'test',
  'tr',
  'type',
  'uniq',
  'xxd',
  'yq',
  'zcat',
  'zipinfo',
  'cksum',
  'date',
  'df',
  'dirname',
  'du',
  'echo',
  'false',
  'file',
  'free',
  'getent',
  'grep',
  'groups',
  'head',
  'hostname',
  'id',
  'journalctl',
  'ls',
  'lsblk',
  'lsb_release',
  'lscpu',
  'md5sum',
  'nproc',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'stat',
  'tail',
  'tree',
  'true',
  'uname',
  'uptime',
  'wc',
  'whereis',
  'which',
  'whoami',
]);

// System diagnostics before an install were refused at 0.94 on an "install
// an RMM agent" thread (`id; ps -p 1; grep PRETTY_NAME /etc/os-release`,
// `systemctl status`), then allowed at 0.81 six hours later (#26). Only the
// verbs that look; `start`/`enable`/`restart` still go to Jev.
const SYSTEMCTL_READ = new Set([
  'is-active',
  'is-enabled',
  'is-failed',
  'is-system-running',
  'list-unit-files',
  'list-units',
  'show',
  'status',
]);
// `find` is a read until one of these runs a program or writes a file.
const FIND_ACTS =
  /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
// Downloading a file to READ it (an installer before running it, a release
// asset) is not building code. Only GETs: these flags send a body, change the
// method or read a config file that could do either.
const DOWNLOAD_SENDS =
  /^(?:-d|--data(?:-\w+)?|-F|--form(?:-string)?|-T|--upload-file|-X|--request|-K|--config|--post-data|--post-file|--body-data|--body-file|--method|-e|--execute)(?:=|$)|^-[dFTXKe]./;
// What a command's output may be piped into: these only filter what they read.
// `sed` and `awk` too, as long as they write no file and run nothing (#26).
const PIPE_FILTERS = new Set([
  'cat',
  'column',
  'cut',
  'egrep',
  'fgrep',
  'grep',
  'head',
  'jq',
  'less',
  'nl',
  'rev',
  'rg',
  'sort',
  'tac',
  'tail',
  'tr',
  'uniq',
  'wc',
  'xxd',
  'yq',
]);
// `sed -i` edits files; awk can `system()` or print into a file or a pipe.
const SED_WRITES = /^(?:-i|--in-place)/;
const AWK_ACTS = /system|getline|[|>]/;

// Read-only git, flags and all (#26: `git remote -v`, `git diff --check` and
// `git branch --show-current` were refused at 0.94-0.98 mid-turn on 2026-11-01).
const GIT_READ = new Set([
  'blame',
  'cat-file',
  'count-objects',
  'describe',
  'diff',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'name-rev',
  'reflog',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'whatchanged',
]);
// These read only in their listing forms.
const GIT_LISTS: Record<string, (rest: string[]) => boolean> = {
  config: (rest) =>
    rest.some((arg) =>
      ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(arg)
    ),
  remote: (rest) =>
    rest.length === 0 ||
    rest.every((arg) => arg === '-v' || arg === '--verbose') ||
    ['get-url', 'show'].includes(rest[0] ?? ''),
  stash: (rest) => rest[0] === 'list' || rest[0] === 'show',
  tag: (rest) =>
    rest.length === 0 || rest.some((arg) => arg === '-l' || arg === '--list'),
  worktree: (rest) => rest[0] === 'list',
};
// Any program asked only for its version.
const VERSION_FLAGS = new Set(['--version', '-V', '-v', 'version']);
// Package managers asked what is installed.
const PACKAGE_READS: Record<string, Set<string>> = {
  bun: new Set(['pm']),
  npm: new Set(['info', 'list', 'ls', 'outdated', 'view']),
  pip: new Set(['freeze', 'list', 'show']),
  pip3: new Set(['freeze', 'list', 'show']),
};
// `timeout 45 git clone …`, `time ls`, `sudo -n true`: the wrapper changes
// nothing about what the command does.
const TIMEOUT_FLAG = /^(?:-k|-s|--kill-after|--signal)$/;
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
// Fetching a repo to READ it (a malware check, an answer from its source) is
// not building code (owner's call 2026-10-13: a clone for a review scored 0.92).
// Only https remotes, and none of the flags that make git run a program:
// `--upload-pack`/`-u`, a hooks `--template`, `-c`/`--config`.
const GIT_FETCH = new Set(['clone', 'fetch']);
const GIT_FETCH_RUNS = /^(?:--upload-pack|-u|--template|-c|--config)(?:=|$)/;
// Committing and pushing a finished document (a skill file, notes) is not
// coding either (owner's call 2026-10-15): a docs-only `git init … gh repo
// create` was refused at 0.90 and handed to the coding agent for 144s (#108). A commit
// can't launder code: whatever it commits was judged when it was written.
const GIT_PUBLISH = new Set(['add', 'commit', 'init', 'push']);
// Starting the branch a PR goes out on: `git switch -c <name>` or
// `git checkout -b <name>`, nothing else (a plain checkout can discard edits).
// A PR chain starting `git switch -c …` was refused at 0.97 (2026-10-18).
const GIT_NEW_BRANCH: Record<string, string> = { checkout: '-b', switch: '-c' };
const BRANCH_NAME = /^\w[\w./-]*$/;
// `--receive-pack`/`--exec` name a program to RUN for a local remote; an init
// `--template` copies hooks in.
const GIT_PUBLISH_RUNS = /^--(?:receive-pack|exec|template)(?:=|$)/;
// `git diff --output=f` and `git log -o f` write a file.
const GIT_WRITES = /^(?:--output|-o)/;

const GH_READ: Record<string, Set<string>> = {
  auth: new Set(['status']),
  gist: new Set(['list', 'view']),
  issue: new Set(['list', 'status', 'view']),
  label: new Set(['list']),
  pr: new Set(['checks', 'diff', 'list', 'status', 'view']),
  release: new Set(['list', 'view']),
  repo: new Set(['clone', 'list', 'view']),
  run: new Set(['list', 'view']),
  search: new Set(['code', 'commits', 'issues', 'prs', 'repos']),
  workflow: new Set(['list', 'view']),
};
const GH_PUBLISH: Record<string, Set<string>> = {
  issue: new Set(['comment', 'create']),
  pr: new Set(['comment', 'create']),
  repo: new Set(['create', 'fork']),
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
// `cd dir && …`, `… && …` (or `;`), and `2>&1 | tail -5`. Null for anything else outside
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
    } else if (command.startsWith('&&', i) || command.startsWith('||', i)) {
      // `a || b` may run either: each side passes on its own, like `&&`.
      endWord();
      tokens.push({ op: '&&' });
      i += 2;
    } else if (char === ';') {
      // Each side still has to pass on its own, exactly as with `&&` (#108's
      // refused line was `git init; gh repo create …`).
      endWord();
      tokens.push({ op: '&&' });
      i += 1;
    } else if (char === '|' && command[i + 1] !== '|') {
      endWord();
      tokens.push({ op: '|' });
      i += 1;
    } else if (word === undefined && NULL_REDIRECT.test(command.slice(i))) {
      i += NULL_REDIRECT.exec(command.slice(i))?.[0].length ?? 1;
    } else if (char === '$' && VARIABLE.test(command.slice(i))) {
      const variable = VARIABLE.exec(command.slice(i))?.[0] ?? '$';
      word = (word ?? '') + variable;
      i += variable.length;
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

const CD_PATH = /^[\w./-]+$/;

// One `&&`-separated command's words, with a trailing `2>&1 | tail -N` peeled
// off (it can't make the command code work). Null if any other operator is in it.
function isFilter([name, ...args]: string[]): boolean {
  if (!name) {
    return false;
  }
  if (name === 'sed') {
    return !args.some((arg) => SED_WRITES.test(arg));
  }
  if (name === 'awk') {
    return !args.some((arg) => AWK_ACTS.test(arg));
  }
  if (name === 'tail') {
    // `tail -f` never ends; everything else only reads.
    return !args.some((arg) => /^-\w*f|^--follow/.test(arg));
  }
  return PIPE_FILTERS.has(name);
}

// One `&&`-separated command's words, with every `| filter` stage after it
// checked and peeled off (they can't make the command code work). Null if a
// stage isn't a filter or another operator is in it.
function segmentArgv(tokens: Token[]): string[] | null {
  const stages: string[][] = [[]];
  for (const token of tokens) {
    if ('op' in token) {
      if (token.op === '|') {
        stages.push([]);
      } else if (token.op !== '2>&1') {
        return null;
      }
    } else {
      stages.at(-1)?.push(token.word);
    }
  }
  const [first, ...filters] = stages;
  if (!first || filters.some((stage) => !isFilter(stage))) {
    return null;
  }
  return first;
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
  // `gh repo clone o/r -- <git flags>`: anything after `--` goes to git.
  if (group === 'repo' && verb === 'clone' && args.includes('--')) {
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

function isNotCodingArgv([head, ...args]: string[]): boolean {
  // `FOO=bar cmd` could point a read-only tool at a different program.
  if (!head || head.includes('=')) {
    return false;
  }
  if (head === 'env') {
    // Bare `env` lists; `env cmd` runs cmd.
    return args.length === 0;
  }
  if (head === 'time' || head === 'nice') {
    return isNotCodingArgv(args);
  }
  if (head === 'sudo') {
    return isNotCodingArgv(args[0] === '-n' ? args.slice(1) : args);
  }
  if (head === 'timeout') {
    let rest = args;
    while (rest[0]?.startsWith('-')) {
      rest = rest.slice(TIMEOUT_FLAG.test(rest[0] ?? '') ? 2 : 1);
    }
    return isNotCodingArgv(rest.slice(1));
  }
  if (args.length === 1 && VERSION_FLAGS.has(args[0] ?? '')) {
    return true;
  }
  if (head in PACKAGE_READS) {
    return PACKAGE_READS[head]?.has(args[0] ?? '') === true;
  }
  if (head === 'tar') {
    // Listing an archive: `tar -tzf a.tgz`, `tar tf a.tar`.
    const mode = (args[0] ?? '').replace(/^-/, '');
    return mode.includes('t') && !/[xcru]/.test(mode);
  }
  if (head === 'unzip') {
    return args.some((arg) => arg === '-l' || arg === '-v' || arg === '-Z');
  }
  if (head === 'sed' || head === 'awk') {
    return isFilter([head, ...args]);
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
    if (sub !== undefined && sub in GIT_NEW_BRANCH) {
      return (
        rest.length === 2 &&
        rest[0] === GIT_NEW_BRANCH[sub] &&
        BRANCH_NAME.test(rest[1] ?? '')
      );
    }
    if (sub === 'branch') {
      return rest.every((arg) => GIT_BRANCH_LISTS.has(arg));
    }
    const lists = sub === undefined ? undefined : GIT_LISTS[sub];
    if (lists) {
      return lists(rest);
    }
    if (sub !== undefined && GIT_FETCH.has(sub)) {
      const urls = rest.filter((arg) => /^[a-z][\w+.-]*:/i.test(arg));
      return (
        !rest.some((arg) => GIT_FETCH_RUNS.test(arg)) &&
        urls.every((url) => url.startsWith('https://'))
      );
    }
    if (sub !== undefined && GIT_PUBLISH.has(sub)) {
      return !rest.some((arg) => GIT_PUBLISH_RUNS.test(arg));
    }
    return (
      sub !== undefined &&
      GIT_READ.has(sub) &&
      !rest.some((arg) => GIT_WRITES.test(arg))
    );
  }
  if (head === 'systemctl') {
    const verb = args.find((arg) => !arg.startsWith('-'));
    return verb !== undefined && SYSTEMCTL_READ.has(verb);
  }
  if (head === 'command') {
    return args[0] === '-v' && args.length > 1;
  }
  if (head === 'find') {
    return !args.some((arg) => FIND_ACTS.test(arg));
  }
  if (head === 'curl' || head === 'wget') {
    return !args.some((arg) => DOWNLOAD_SENDS.test(arg));
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
  // The gh tool runs `repo view …` as `gh repo view …`; judged as written, a
  // read-only `repo view` matched nothing here and Jev refused it at 0.95.
  if (!parsed.success) {
    return false;
  }
  const command =
    toolName === 'gh'
      ? withGhPrefixes(parsed.data.command)
      : parsed.data.command;
  const tokens = tokenize(command.trim());
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
