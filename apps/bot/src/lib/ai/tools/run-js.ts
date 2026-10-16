import { tool } from 'ai';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { z } from 'zod';
import { errorMessage } from '@/lib/utils/error';

// A sum, a date difference or a JSON reshape used to start (or resume) an E2B
// sandbox: seconds of cold start and a share of the free credits for `19 * 7`.
// QuickJS runs on kyto's host instead, and is safe there BY CONSTRUCTION: the
// VM has no network, no filesystem, no process, no host objects — only the
// `console` defined below — so there is nothing for the code to reach.
const TIME_LIMIT_MS = 2000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const OUTPUT_MAX = 8000;

function clip(text: string): string {
  return text.length > OUTPUT_MAX
    ? `${text.slice(0, OUTPUT_MAX)}… [${text.length - OUTPUT_MAX} more chars cut]`
    : text;
}

function show(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

/** Run `code` in a fresh QuickJS VM; the result and console output, or why it failed. */
export async function runJs(code: string) {
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS)
  );
  const vm = runtime.newContext();
  const logs: string[] = [];
  try {
    const log = vm.newFunction('log', (...args) => {
      logs.push(args.map((arg) => show(vm.dump(arg))).join(' '));
    });
    const consoleObject = vm.newObject();
    vm.setProp(consoleObject, 'log', log);
    vm.setProp(consoleObject, 'error', log);
    vm.setProp(vm.global, 'console', consoleObject);
    consoleObject.dispose();
    log.dispose();

    const evaluated = vm.evalCode(code, 'run.js');
    const output = clip(logs.join('\n'));
    if (evaluated.error) {
      const failure = vm.dump(evaluated.error);
      evaluated.error.dispose();
      return {
        error: show(failure),
        ...(output ? { output } : {}),
        success: false,
      };
    }
    const result = vm.dump(evaluated.value);
    evaluated.value.dispose();
    return {
      ...(result === undefined ? {} : { result: clip(show(result)) }),
      ...(output ? { output } : {}),
      success: true,
    };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

export function runJsTool() {
  return tool({
    description:
      'Run a short piece of plain JavaScript instantly, for maths, dates, string or JSON work. No sandbox start. The value of the last expression is returned, plus anything passed to console.log. It has NO network, files, imports, timers or npm packages, and stops after 2 seconds and 32 MB; for any of those use bash or codeMode in the sandbox.',
    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .max(20_000)
        .describe(
          'JavaScript. The last expression is the result, e.g. `const d = new Date("2026-12-25") - new Date(); Math.ceil(d / 864e5)`.'
        ),
    }),
    execute: ({ code }) => runJs(code),
  });
}
