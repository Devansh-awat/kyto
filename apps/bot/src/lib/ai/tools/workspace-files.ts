import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { fileDiagnostics } from '@/lib/sandbox/diagnostics';
import { OUTPUT_MAX } from '@/lib/sandbox/output-clip';
import { clamp } from '@/lib/utils/text';

// The file half of the model's workspace tools: read, write, edit, and search
// by content (grep) or name (glob). Apart from bash (tools/sandbox.ts) so they
// can be tested: that module reaches the GitHub guard and the environment.

export function resolvePath(context: SandboxContext, path: string): string {
  return nodePath.normalize(
    path.startsWith('/') ? path : nodePath.join(context.sessionWorkDir, path)
  );
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * What this turn has read of each file, so writeFile and editFile can refuse a
 * blind or stale change: a file the model never read this turn is only a guess
 * at its contents, and one that changed since (a formatter, its own `sed`, a
 * subagent) would be edited against text that is no longer there. Per TURN on
 * purpose: a new turn starts without the file in its context. One per
 * buildTools, so a subagent keeps its own.
 */
export function createFileReads() {
  const seen = new Map<string, number>();
  return {
    record(path: string, text: string): void {
      seen.set(path, Bun.hash(text) as number);
    },
    /** Why a change to this file must wait for a read, or undefined. */
    check(path: string, text: string): string | undefined {
      const at = seen.get(path);
      if (at === undefined) {
        return `${path} already exists and you haven't read it this turn, so nothing was changed. Read it with readFile first (a line range is enough), then make the change against what is really there.`;
      }
      if (at !== (Bun.hash(text) as number)) {
        return `${path} changed since you last read it (a command, a formatter or a subagent touched it), so nothing was changed. Read it again and redo the change against the current text.`;
      }
      return;
    },
  };
}

export type FileReads = ReturnType<typeof createFileReads>;

// Lines over this are shown in pieces: a 75 KB story with 10k-character lines
// has to be readable in full, and a numbered view of one cut line is not.
const MAX_LINE_SHOWN = OUTPUT_MAX;

export function readFileTool({
  getSandboxContext,
  reads,
}: {
  getSandboxContext: () => SandboxContext;
  reads?: FileReads;
}) {
  return tool({
    description:
      'Read a text file from the sandbox workspace (null if it does not exist). Lines come back NUMBERED, as `N<tab>text`: the number and the tab are not part of the file, so never copy them into editFile. Up to 12,000 characters per call: when the result has `nextLine`, call again with `startLine: nextLine` (and `column: nextColumn` when given, for a very long line) to read on, several in parallel is fine, until there is none: that is how to read a long file IN FULL. Use `startLine`/`endLine` for just the part you need. You must read a file this turn before writeFile overwrites it or editFile changes it.',
    inputSchema: z.object({
      column: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Where in `startLine` to start, for a line too long for one call: a previous result's `nextColumn`."
        ),
      endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Last line to read (inclusive).'),
      path: z.string(),
      startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "First line to read (1-based): a previous result's `nextLine`."
        ),
    }),
    execute: async ({ column = 0, endLine, path, startLine = 1 }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const bytes = await context.session.readBinaryFile({ path: resolved });
      if (!bytes) {
        return { content: null, found: false };
      }
      const text = new TextDecoder().decode(bytes);
      reads?.record(resolved, text);
      const lines = text.split('\n');
      if (text.endsWith('\n')) {
        lines.pop();
      }
      const last = Math.min(endLine ?? lines.length, lines.length);
      // Contiguous parts by WHOLE lines, numbered like `cat -n`, so an edit
      // can be aimed by line and a long file read in order without gaps.
      const shown: string[] = [];
      let used = 0;
      let nextLine: number | undefined;
      let nextColumn: number | undefined;
      for (let number = startLine; number <= last; number++) {
        const line = lines[number - 1] ?? '';
        const from = number === startLine ? column : 0;
        const rest = line.length - from;
        if (rest > MAX_LINE_SHOWN - used) {
          if (shown.length > 0) {
            nextLine = number;
            break;
          }
          // One line longer than a whole part: show a piece of it.
          const end = from + (MAX_LINE_SHOWN - used);
          shown.push(`${number}\t${line.slice(from, end)}`);
          nextLine = number;
          nextColumn = end;
          break;
        }
        shown.push(`${number}\t${line.slice(from)}`);
        used += rest + String(number).length + 2;
      }
      return {
        content: shown.join('\n'),
        found: true,
        ...(nextLine === undefined ? {} : { nextLine }),
        ...(nextColumn === undefined ? {} : { nextColumn }),
        totalLines: lines.length,
      };
    },
  });
}

export function writeFileTool({
  getSandboxContext,
  reads,
}: {
  getSandboxContext: () => SandboxContext;
  reads?: FileReads;
}) {
  return tool({
    description:
      'Write a text file in the sandbox workspace (creates parent directories, overwrites existing content). Overwriting a file that already exists needs a readFile of it this turn first, and is refused if it changed since. Your reply (including this tool call) is capped at a few thousand tokens, so a single call CANNOT carry a very large file: content over roughly 400 lines gets cut off mid-argument. Write a big file in successive chunks instead: the first call with append:false, each following call with append:true. A whole-file write is checked afterwards (parse, and tsc for TypeScript) and any errors come back in `diagnostics`: fix them before moving on. Chunked appends are NOT checked, because the file is incomplete until the last one; check those yourself with bash.',
    inputSchema: z.object({
      append: z
        .boolean()
        .optional()
        .describe(
          'Append to the file instead of overwriting it. Use this to build a large file across several calls.'
        ),
      content: z.string(),
      path: z.string(),
    }),
    execute: async ({ append, content, path }, { abortSignal }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const existing = await context.session.readBinaryFile({
        path: resolved,
      });
      const before = existing ? new TextDecoder().decode(existing) : undefined;
      // Overwriting unseen content is the one write that loses work. An
      // append keeps everything, and a chunked write's later appends follow
      // a first write this tool recorded.
      const refusal =
        before !== undefined && !append
          ? reads?.check(resolved, before)
          : undefined;
      if (refusal) {
        return { error: refusal, written: false };
      }
      const next =
        append && before !== undefined ? `${before}${content}` : content;
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(next),
        path: resolved,
      });
      reads?.record(resolved, next);
      // An append is a PARTIAL file by construction — checking it would report
      // "unexpected end of file" on every chunk but the last, which trains the
      // model to ignore diagnostics. Only whole-file writes are checked.
      const diagnostics = append
        ? undefined
        : await fileDiagnostics({ abortSignal, context, path: resolved });
      return {
        appended: Boolean(append),
        bytes: next.length,
        ...(diagnostics ? { diagnostics } : {}),
        path: resolved,
        written: true,
      };
    },
  });
}

/** Collapse every run of whitespace so two texts differing only in indentation
 * or wrapping compare equal. */
function squashWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Why an exact match failed, in terms the model can act on. "not found" alone
 * sends it into a guess-and-retry loop; nearly every real miss is one of three
 * things, and naming which one turns a retry into a fix.
 */
function noMatchReason(text: string, oldString: string): string {
  const base = 'oldString was not found in the file, so nothing was changed.';
  if (text.includes('\r\n') && !oldString.includes('\r\n')) {
    return `${base} The file uses CRLF line endings and your oldString uses LF: copy the text out of readFile instead of retyping it.`;
  }
  if (squashWhitespace(text).includes(squashWhitespace(oldString))) {
    return `${base} The text IS there but the whitespace differs (indentation, tabs vs spaces, or a line break). Read the file and copy the region exactly as it appears.`;
  }
  const [firstLine] = oldString.split('\n');
  if (firstLine && firstLine.trim().length > 0 && text.includes(firstLine)) {
    return `${base} Its first line ("${clamp(firstLine.trim(), 80)}") does appear, so the mismatch is somewhere after it: re-read that region and copy it exactly.`;
  }
  return `${base} Read the file first and copy the exact region you mean to replace.`;
}

export function editFileTool({
  getSandboxContext,
  reads,
}: {
  getSandboxContext: () => SandboxContext;
  reads?: FileReads;
}) {
  return tool({
    description:
      'Edit a text file in the sandbox by exact string replacement. Read the file with readFile this turn first: an edit to a file you have not read, or that changed since you read it, is refused. oldString must match the file contents exactly (including whitespace) and, unless replaceAll is true, exactly once: a miss or an ambiguous match FAILS rather than guessing. After a successful edit the file is checked (parse, and tsc for TypeScript) and any errors come back in `diagnostics`; fix them before moving on.',
    inputSchema: z.object({
      newString: z.string(),
      oldString: z.string(),
      path: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    execute: async (
      { newString, oldString, path, replaceAll },
      { abortSignal }
    ) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const bytes = await context.session.readBinaryFile({ path: resolved });
      if (!bytes) {
        throw new Error(`File not found: ${resolved}`);
      }
      const text = new TextDecoder().decode(bytes);
      const refusal = reads?.check(resolved, text);
      if (refusal) {
        throw new Error(refusal);
      }
      const occurrences = text.split(oldString).length - 1;
      if (occurrences === 0) {
        throw new Error(noMatchReason(text, oldString));
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `oldString matches ${occurrences} times in ${resolved}, so this edit is ambiguous and was NOT applied. Include more surrounding lines to make it unique, or set replaceAll:true if you really mean all ${occurrences}.`
        );
      }
      // A replacer FUNCTION, not the string: as a string, `$&`, `$$`, `$'` and
      // `` $` `` in newString are replacement patterns, which mangled shell and
      // regex code (`$$` became `$`).
      const updated = replaceAll
        ? text.replaceAll(oldString, () => newString)
        : text.replace(oldString, () => newString);
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(updated),
        path: resolved,
      });
      reads?.record(resolved, updated);
      const diagnostics = await fileDiagnostics({
        abortSignal,
        context,
        path: resolved,
      });
      return {
        ...(diagnostics ? { diagnostics } : {}),
        path: resolved,
        replaced: occurrences,
      };
    },
  });
}

const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 1000;
const MAX_CONTEXT_LINES = 10;
// rg's trailer: its exit code and how many lines it printed in all.
const SEARCH_TRAILER = /\n?(\d+) (\d+)\n?$/;

/**
 * ripgrep, run with fixed flags and the model's values only as quoted
 * arguments after `-e`/`--glob`/`--`, so a pattern can't become a flag (rg's
 * `--pre` runs a program). Hidden files are searched, `.git` and anything
 * .gitignored (node_modules, mostly) are not unless asked.
 */
async function ripgrep({
  abortSignal,
  args,
  context,
  includeIgnored,
  limit,
  path,
}: {
  abortSignal?: AbortSignal;
  args: string[];
  context: SandboxContext;
  includeIgnored?: boolean;
  limit: number;
  path?: string;
}): Promise<{ error?: string; lines: string[]; total: number }> {
  const target = path ? resolvePath(context, path) : '.';
  const flags = [
    '--no-config',
    '--hidden',
    '--color=never',
    "--glob='!.git'",
    ...(includeIgnored ? ['--no-ignore'] : []),
    ...args,
  ];
  // Temp files, not a pipe: `rg | head` hides rg's exit code and how much was
  // cut. Fresh ones per call: parallel searches share the sandbox.
  const result = await context.session.run({
    abortSignal,
    command: `out=$(mktemp); err=$(mktemp); rg ${flags.join(' ')} -- ${shellQuote(target)} > "$out" 2>"$err"; code=$?; head -n ${limit} "$out"; printf '\\n%s %s\\n' "$code" "$(wc -l < "$out")"; head -c 2000 "$err" >&2; rm -f "$out" "$err"`,
    workingDirectory: context.sessionWorkDir,
  });
  const trailer = SEARCH_TRAILER.exec(result.stdout);
  const code = Number(trailer?.[1] ?? 2);
  const body = trailer ? result.stdout.slice(0, trailer.index) : result.stdout;
  // 1 = nothing matched, which is an answer, not an error.
  if (code > 1) {
    return {
      error: result.stderr.trim() || `rg exited with ${code}.`,
      lines: [],
      total: 0,
    };
  }
  return {
    lines: body.split('\n').filter(Boolean),
    total: Number(trailer?.[2] ?? 0),
  };
}

export function grepTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Search file CONTENTS in the sandbox with a regex (ripgrep). Prefer it over `grep`/`rg` in bash. `outputMode`: `files` (default) lists the files that match, newest first; `content` shows the matching lines as `path:line:text`, with `context` lines around them; `count` gives matches per file. Skips .git and .gitignored files (node_modules, build output) unless `includeIgnored`. Too many results? Narrow the pattern, `path` or `glob` rather than raising `maxResults`.',
    inputSchema: z.object({
      context: z
        .number()
        .int()
        .min(0)
        .max(MAX_CONTEXT_LINES)
        .optional()
        .describe('Lines before and after each match [content mode].'),
      glob: z
        .string()
        .optional()
        .describe(
          'Only files matching this glob, e.g. `*.ts` or `src/**/*.{ts,tsx}`.'
        ),
      ignoreCase: z.boolean().optional(),
      includeIgnored: z
        .boolean()
        .optional()
        .describe('Also search .gitignored files (node_modules and the like).'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_RESULTS)
        .optional()
        .describe(
          `Lines of output to return (default ${DEFAULT_SEARCH_RESULTS}).`
        ),
      outputMode: z.enum(['files', 'content', 'count']).optional(),
      path: z
        .string()
        .optional()
        .describe('File or directory to search (default: the workspace).'),
      pattern: z
        .string()
        .min(1)
        .describe(
          'Regex (Rust syntax: escape `{`, `(`, `.` to match them literally).'
        ),
    }),
    execute: async (
      {
        context: around,
        glob,
        ignoreCase,
        includeIgnored,
        maxResults = DEFAULT_SEARCH_RESULTS,
        outputMode = 'files',
        path,
        pattern,
      },
      { abortSignal }
    ) => {
      const modeFlags = {
        content: [
          '--line-number',
          '--no-heading',
          '--with-filename',
          ...(around ? [`--context=${around}`] : []),
        ],
        count: ['--count', '--with-filename'],
        files: ['--files-with-matches', '--sortr=modified'],
      }[outputMode];
      const found = await ripgrep({
        abortSignal,
        args: [
          ...modeFlags,
          ...(ignoreCase ? ['--ignore-case'] : []),
          ...(glob ? [`--glob=${shellQuote(glob)}`] : []),
          `-e ${shellQuote(pattern)}`,
        ],
        context: getSandboxContext(),
        includeIgnored,
        limit: maxResults,
        path,
      });
      if (found.error) {
        return { error: found.error, success: false };
      }
      const cut = found.total > found.lines.length;
      return {
        mode: outputMode,
        results: found.lines,
        success: true,
        summary:
          found.total === 0
            ? `No matches for /${pattern}/${glob ? ` in ${glob}` : ''}.${includeIgnored ? '' : ' (.gitignored files were skipped.)'}`
            : `${found.total} ${outputMode === 'files' ? 'files' : 'lines'}${cut ? `, first ${found.lines.length} shown: narrow the search to see the rest` : ''}.`,
        total: found.total,
      };
    },
  });
}

export function globTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Find files in the sandbox by NAME pattern (glob), newest first, e.g. `**/*.ts`, `src/**/test_*.py`, `**/package.json`. Prefer it over `find`/`ls -R` in bash. Skips .git and .gitignored files (node_modules, build output) unless `includeIgnored`. To search what files CONTAIN, use grep.',
    inputSchema: z.object({
      includeIgnored: z
        .boolean()
        .optional()
        .describe('Also list .gitignored files (node_modules and the like).'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_RESULTS)
        .optional()
        .describe(`Files to return (default ${DEFAULT_SEARCH_RESULTS}).`),
      path: z
        .string()
        .optional()
        .describe('Directory to search under (default: the workspace).'),
      pattern: z.string().min(1),
    }),
    execute: async (
      { includeIgnored, maxResults = DEFAULT_SEARCH_RESULTS, path, pattern },
      { abortSignal }
    ) => {
      const found = await ripgrep({
        abortSignal,
        args: ['--files', '--sortr=modified', `--glob=${shellQuote(pattern)}`],
        context: getSandboxContext(),
        includeIgnored,
        limit: maxResults,
        path,
      });
      if (found.error) {
        return { error: found.error, success: false };
      }
      const cut = found.total > found.lines.length;
      return {
        files: found.lines,
        success: true,
        summary:
          found.total === 0
            ? `No files match ${pattern}.${includeIgnored ? '' : ' (.gitignored files were skipped.)'}`
            : `${found.total} files${cut ? `, newest ${found.lines.length} shown: narrow the pattern to see the rest` : ''}.`,
        total: found.total,
      };
    },
  });
}
