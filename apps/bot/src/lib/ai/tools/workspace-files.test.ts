import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type { SandboxContext } from '@repo/ai';
import type { Tool } from 'ai';
import {
  createFileReads,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  writeFileTool,
} from './workspace-files';

// A sandbox that is a temp directory on this machine: files through fs,
// commands through bash.
function localSandbox(): { context: SandboxContext; dir: string } {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'kyto-sandbox-'));
  const session = {
    destroy: () => Promise.resolve(),
    getHost: () => Promise.resolve('localhost'),
    readBinaryFile: ({ path }: { path: string }) => {
      try {
        return Promise.resolve(new Uint8Array(readFileSync(path)));
      } catch {
        return Promise.resolve(null);
      }
    },
    readFileStream: () => Promise.resolve(null),
    fileSize: ({ path }: { path: string }) => {
      try {
        return Promise.resolve(readFileSync(path).byteLength);
      } catch {
        return Promise.resolve(null);
      }
    },
    run: ({
      command,
      workingDirectory,
    }: {
      command: string;
      workingDirectory?: string;
    }) => {
      const done = Bun.spawnSync(['bash', '-c', command], {
        cwd: workingDirectory ?? dir,
      });
      return Promise.resolve({
        exitCode: done.exitCode ?? 1,
        stderr: done.stderr.toString(),
        stdout: done.stdout.toString(),
      });
    },
    writeBinaryFile: ({
      content,
      path,
    }: {
      content: Uint8Array;
      path: string;
    }) => {
      writeFileSync(path, content);
      return Promise.resolve();
    },
  };
  return {
    context: { session, sessionWorkDir: dir } as unknown as SandboxContext,
    dir,
  };
}

async function call(tool: Tool, input: object): Promise<unknown> {
  if (!tool.execute) {
    throw new Error('tool has no execute');
  }
  return await tool.execute(
    input as never,
    {
      abortSignal: undefined,
    } as never
  );
}

describe('readFile', () => {
  test('numbers lines and pages by whole lines', async () => {
    const { context, dir } = localSandbox();
    writeFileSync(nodePath.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const read = readFileTool({ getSandboxContext: () => context });
    expect(await call(read, { path: 'a.txt' })).toEqual({
      content: '1\tone\n2\ttwo\n3\tthree',
      found: true,
      totalLines: 3,
    });
    expect(
      await call(read, { endLine: 2, path: 'a.txt', startLine: 2 })
    ).toMatchObject({ content: '2\ttwo' });
  });

  test('a line too long for one call is read in pieces', async () => {
    const { context, dir } = localSandbox();
    const long = 'x'.repeat(30_000);
    writeFileSync(nodePath.join(dir, 'long.txt'), `${long}\nend`);
    const read = readFileTool({ getSandboxContext: () => context });
    const first = (await call(read, { path: 'long.txt' })) as {
      content: string;
      nextColumn: number;
      nextLine: number;
    };
    expect(first.nextLine).toBe(1);
    let seen = first.content.length - 2;
    let next: { content: string; nextColumn?: number; nextLine?: number } =
      first;
    while (next.nextLine === 1) {
      next = (await call(read, {
        column: next.nextColumn,
        path: 'long.txt',
        startLine: 1,
      })) as typeof next;
      seen += (next.content.split('\n')[0] ?? '').length - 2;
    }
    expect(seen).toBe(30_000);
    expect(next.content.endsWith('2\tend')).toBe(true);
  });
});

describe('read before write', () => {
  test('an unread file is refused, a read one is edited', async () => {
    const { context, dir } = localSandbox();
    const path = nodePath.join(dir, 'f.ts');
    writeFileSync(path, 'const a = 1;\n');
    const reads = createFileReads();
    const getSandboxContext = () => context;
    const edit = editFileTool({ getSandboxContext, reads });
    await expect(
      call(edit, { newString: '2', oldString: '1', path: 'f.ts' })
    ).rejects.toThrow("haven't read it this turn");
    await call(readFileTool({ getSandboxContext, reads }), { path: 'f.ts' });
    await call(edit, { newString: '2', oldString: '1', path: 'f.ts' });
    expect(readFileSync(path, 'utf8')).toBe('const a = 2;\n');
    // Its own edit doesn't make the file stale.
    await call(edit, { newString: '3', oldString: '2', path: 'f.ts' });
    expect(readFileSync(path, 'utf8')).toBe('const a = 3;\n');
  });

  test('a file changed since the read is refused', async () => {
    const { context, dir } = localSandbox();
    const path = nodePath.join(dir, 'f.txt');
    writeFileSync(path, 'old\n');
    const reads = createFileReads();
    const getSandboxContext = () => context;
    await call(readFileTool({ getSandboxContext, reads }), { path: 'f.txt' });
    writeFileSync(path, 'changed by a command\n');
    const result = await call(writeFileTool({ getSandboxContext, reads }), {
      content: 'new\n',
      path: 'f.txt',
    });
    expect(result).toMatchObject({ written: false });
    expect(readFileSync(path, 'utf8')).toBe('changed by a command\n');
  });

  test('a new file, and appends to it, need no read', async () => {
    const { context, dir } = localSandbox();
    const write = writeFileTool({
      getSandboxContext: () => context,
      reads: createFileReads(),
    });
    await call(write, { content: 'a', path: 'n.txt' });
    await call(write, { append: true, content: 'b', path: 'n.txt' });
    await call(write, { content: 'c', path: 'n.txt' });
    expect(readFileSync(nodePath.join(dir, 'n.txt'), 'utf8')).toBe('c');
  });
});

describe('grep', () => {
  const hasRg = Bun.which('rg') !== null;
  test.skipIf(!hasRg)(
    'finds content, quotes a pattern that looks like a flag',
    async () => {
      const { context, dir } = localSandbox();
      writeFileSync(nodePath.join(dir, 'a.ts'), 'let x = 1;\n--pre=evil\n');
      writeFileSync(nodePath.join(dir, 'b.md'), 'nothing\n');
      const grep = grepTool({ getSandboxContext: () => context });
      expect(await call(grep, { pattern: 'let x' })).toMatchObject({
        results: ['./a.ts'],
        total: 1,
      });
      expect(
        await call(grep, { outputMode: 'content', pattern: '--pre=evil' })
      ).toMatchObject({ results: ['./a.ts:2:--pre=evil'] });
      expect(await call(grep, { pattern: 'absent' })).toMatchObject({
        total: 0,
      });
    }
  );

  test.skipIf(!hasRg)('glob finds by name and skips .git', async () => {
    const { context, dir } = localSandbox();
    Bun.spawnSync(['mkdir', '-p', `${dir}/src/deep`, `${dir}/.git`]);
    writeFileSync(nodePath.join(dir, 'src/deep/x.ts'), '');
    writeFileSync(nodePath.join(dir, 'src/y.js'), '');
    writeFileSync(nodePath.join(dir, '.git/z.ts'), '');
    const glob = globTool({ getSandboxContext: () => context });
    expect(await call(glob, { pattern: '**/*.ts' })).toMatchObject({
      files: ['./src/deep/x.ts'],
      total: 1,
    });
  });
});
