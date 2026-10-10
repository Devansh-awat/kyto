import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

// Runs before every test file, in the one process `bun test` shares between
// them. `@/env` validates and freezes the environment on first import, so a
// test file setting process.env itself is too late whenever another file
// imported env first — which is how the whiteboard tests wrote to the real
// /var/kytosites and failed only in the full run.
//
// From the repo root there is no .env (it lives in apps/bot), so the required
// keys get placeholders; a real .env still wins, and no test needs a working
// key. Site files always go to a scratch directory, never the real root.
const PLACEHOLDERS: Record<string, string> = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  E2B_API_KEY: 'test',
  EXA_API_KEY: 'test',
  HACKCLUB_API_KEY: 'sk-hc-test',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'test',
};

for (const [name, value] of Object.entries(PLACEHOLDERS)) {
  process.env[name] ??= value;
}
process.env.SITES_ROOT = mkdtempSync(nodePath.join(tmpdir(), 'kyto-sites-'));
