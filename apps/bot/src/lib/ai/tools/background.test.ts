import { describe, expect, test } from 'bun:test';
import type { SandboxContext } from '@repo/ai';
import type { Tool } from 'ai';
import type { Message } from '@/harness/types';

// background.ts reaches lib/github/guard, which sits in an import cycle with
// lib/github/contributions (its GITHUB_LOGIN is read before it is set when the
// guard is the entry point). The app loads contributions first; so does this.
await import('@/lib/github/contributions');
const {
  backgroundProcessTools,
  backgroundRegistrySizes,
  hasThreadProcesses,
  killThreadProcesses,
} = await import('./background');

// A sandbox whose jobs finish when the test says so. Files are a Map; `run`
// answers the three shell shapes background.ts sends: the launcher (prints a
// pid), a poll (base64 of the exit/out/err files) and a kill.
function fakeSandbox() {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const b64 = (path: string) =>
    files.has(path)
      ? Buffer.from(files.get(path) ?? '').toString('base64')
      : '';
  const context: SandboxContext = {
    session: {
      destroy: () => Promise.resolve(),
      fileSize: () => Promise.resolve(null),
      getHost: () => Promise.resolve('localhost'),
      readBinaryFile: () => Promise.resolve(null),
      run: ({ command }) => {
        commands.push(command);
        if (command.startsWith('nohup setsid sh')) {
          return Promise.resolve({ exitCode: 0, stderr: '', stdout: '4242\n' });
        }
        const paths = [...command.matchAll(/"([^"]+\.(?:exit|out|err))"/g)].map(
          (match) => match[1] ?? ''
        );
        return Promise.resolve({
          exitCode: 0,
          stderr: '',
          stdout: paths.map((path) => `${b64(path)}\n`).join(''),
        });
      },
      writeBinaryFile: () => Promise.resolve(),
    },
    sessionWorkDir: '/work',
  } as SandboxContext;
  // Finish every job started so far, with this stdout.
  const finishAll = (stdout = 'done\n') => {
    for (const command of commands) {
      const base = command.match(/\.kyto-bg-[^'"]+?(?=\.sh)/)?.[0];
      if (base) {
        files.set(`/work/${base}.out`, stdout);
        files.set(`/work/${base}.err`, '');
        files.set(`/work/${base}.exit`, '0\n');
      }
    }
  };
  return { commands, context, finishAll };
}

const wakeFor = (threadId: string) => ({
  asUserAccount: false,
  message: { id: 'm1' } as Message,
  thread: { id: threadId } as never,
});

async function call(tool: Tool, input: object): Promise<unknown> {
  if (!tool.execute) {
    throw new Error('tool has no execute');
  }
  return await tool.execute(
    input as never,
    { abortSignal: undefined } as never
  );
}

describe('background registry lifetime', () => {
  test('a finished foreground command leaves nothing behind', async () => {
    const before = backgroundRegistrySizes();
    const { context, finishAll } = fakeSandbox();
    const threadId = 'slack:C1:1.000001';
    const background = backgroundProcessTools({
      getSandboxContext: () => context,
      github: { isOwner: false, threadId, userId: 'U1' },
      wake: wakeFor(threadId),
    });
    const started = await background.startManaged('echo hi');
    if ('error' in started) {
      throw new Error(started.error);
    }
    finishAll('hi\n');
    const result = await background.waitManaged(started.id, 5000);
    expect(result).toMatchObject({
      exitCode: 0,
      finished: true,
      stdout: 'hi\n',
    });
    // The handle went with the result: a STOP has nothing to kill.
    expect(hasThreadProcesses(threadId)).toBe(false);
    expect(backgroundRegistrySizes()).toEqual(before);
  });

  test('a running job keeps its registry past the turn, so STOP still reaches it', async () => {
    const before = backgroundRegistrySizes();
    const { commands, context } = fakeSandbox();
    const threadId = 'slack:C1:1.000002';
    const background = backgroundProcessTools({
      getSandboxContext: () => context,
      github: { isOwner: false, threadId, userId: 'U1' },
      wake: wakeFor(threadId),
    });
    const started = (await call(background.runBackgroundProcess, {
      command: 'sleep 999',
    })) as { id: string; success: boolean };
    expect(started.success).toBe(true);
    // The turn is over but the job is not: still listed for a STOP.
    expect(hasThreadProcesses(threadId)).toBe(true);
    expect(await killThreadProcesses(threadId)).toBe(1);
    expect(commands.at(-1)).toContain('for p in 4242; do kill -9 -$p');
    expect(backgroundRegistrySizes()).toEqual(before);
  });

  test('a job started after a STOP in the same turn is reached by the next STOP', async () => {
    const before = backgroundRegistrySizes();
    const { context } = fakeSandbox();
    const threadId = 'slack:C1:1.000005';
    const background = backgroundProcessTools({
      getSandboxContext: () => context,
      github: { isOwner: false, threadId, userId: 'U1' },
      wake: wakeFor(threadId),
    });
    await call(background.runBackgroundProcess, { command: 'sleep 1' });
    expect(await killThreadProcesses(threadId)).toBe(1);
    await call(background.runBackgroundProcess, { command: 'sleep 2' });
    expect(hasThreadProcesses(threadId)).toBe(true);
    expect(await killThreadProcesses(threadId)).toBe(1);
    expect(backgroundRegistrySizes()).toEqual(before);
  });

  test('killProcess drops the now-empty registry', async () => {
    const before = backgroundRegistrySizes();
    const { context } = fakeSandbox();
    const threadId = 'slack:C1:1.000003';
    const background = backgroundProcessTools({
      getSandboxContext: () => context,
      github: { isOwner: false, threadId, userId: 'U1' },
      wake: wakeFor(threadId),
    });
    const started = (await call(background.runBackgroundProcess, {
      command: 'sleep 999',
    })) as { id: string };
    expect(backgroundRegistrySizes()).not.toEqual(before);
    expect(
      await call(background.killProcess, { id: started.id })
    ).toMatchObject({
      success: true,
    });
    expect(backgroundRegistrySizes()).toEqual(before);
  });

  test('two builds on one thread share its jobs', async () => {
    const before = backgroundRegistrySizes();
    const { context } = fakeSandbox();
    const threadId = 'slack:C1:1.000004';
    const options = {
      getSandboxContext: () => context,
      github: { isOwner: false, threadId, userId: 'U1' },
      wake: wakeFor(threadId),
    };
    const first = backgroundProcessTools(options);
    const second = backgroundProcessTools(options);
    const started = (await call(second.runBackgroundProcess, {
      command: 'sleep 999',
    })) as { id: string };
    // The first build can still see the second's job: one registry per thread.
    expect(
      await call(first.getProcessOutput, { id: started.id })
    ).toMatchObject({ running: true, success: true });
    expect(hasThreadProcesses(threadId)).toBe(true);
    await call(second.killProcess, { id: started.id });
    expect(backgroundRegistrySizes()).toEqual(before);
  });

  test('a finished turn no longer keeps its scope alive', async () => {
    const { heapStats } = await import('bun:jsc');
    const functions = () => {
      Bun.gc(true);
      return heapStats().objectTypeCounts.Function ?? 0;
    };
    const { context } = fakeSandbox();
    // A turn's scope: a large toolset of closures, plus the inline
    // `() => context` handed to the registry, which shares that scope.
    const turn = (threadId: string) => {
      const toolset = Array.from({ length: 5000 }, (_, i) => () => i);
      backgroundProcessTools({
        getSandboxContext: () => (toolset.length > 0 ? context : context),
        github: { isOwner: false, threadId, userId: 'U1' },
        wake: wakeFor(threadId),
      });
    };
    const start = functions();
    for (let i = 0; i < 10; i++) {
      turn(`slack:C2:2.00000${i}`);
    }
    // Before the fix each thread pinned its turn's 5000 closures: +50k here.
    expect(functions() - start).toBeLessThan(5000);
  });
});
