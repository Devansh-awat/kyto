import { describe, expect, test } from 'bun:test';
import { LazySandbox } from './lazy-sandbox';

/** Runs `bootstrap` against a fake sandbox whose commands go to real bash. */
async function bootstrapWith(bootstrapCommand: string | undefined) {
  const scripts: string[] = [];
  const warnings: string[] = [];
  const lazy = new LazySandbox({
    apiKey: 'test',
    bootstrapCommand,
    logger: {
      info: () => undefined,
      warn: (_fields: unknown, message: string) => warnings.push(message),
    } as never,
  });
  const fake = {
    commands: {
      run: (script: string) => {
        scripts.push(script);
        // The real steps write to /usr/local/bin and git config; only the
        // shape of the script is under test, so run it with those stubbed.
        const done = Bun.spawnSync([
          'bash',
          '-c',
          `git() { :; }; cat() { command cat >/dev/null; }; chmod() { :; }\n${script}`,
        ]);
        return Promise.resolve({
          exitCode: done.exitCode ?? 1,
          stderr: done.stderr.toString(),
          stdout: done.stdout.toString(),
        });
      },
    },
    sandboxId: 'sbx-test',
  };
  await (
    lazy as unknown as { bootstrap: (sandbox: unknown) => Promise<void> }
  ).bootstrap(fake);
  return { scripts, warnings };
}

describe('bootstrap', () => {
  test('runs every step in one command, in order', async () => {
    const { scripts, warnings } = await bootstrapWith('echo third');
    expect(scripts).toHaveLength(1);
    const script = scripts[0] ?? '';
    expect(script.indexOf('core.hooksPath')).toBeLessThan(
      script.indexOf('kyto-display')
    );
    expect(script.indexOf('kyto-display')).toBeLessThan(
      script.indexOf('echo third')
    );
    expect(warnings).toEqual([]);
  });

  test('a failing step (even one that exits) skips none after it, and is logged', async () => {
    const marker = `/tmp/kyto-bootstrap-${process.pid}-${Date.now()}`;
    const { warnings } = await bootstrapWith('exit 3');
    expect(warnings).toEqual(['[sandbox] bootstrap step failed']);
    const after = await bootstrapWith(`false; touch ${marker}`);
    expect(after.warnings).toEqual([]);
    expect(await Bun.file(marker).exists()).toBe(true);
    await Bun.file(marker).delete();
  });

  test('without a bootstrap command, the two built-in steps still run', async () => {
    const { scripts } = await bootstrapWith(undefined);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('core.hooksPath');
    expect(scripts[0]).toContain('kyto-display');
  });
});
