# Publishing the source

Kyto's source is published so it can be **read**, not taken: see [`LICENSE`](../../LICENSE)
(source-available, all rights reserved) and [`LICENSE-gorkie-MIT`](../../LICENSE-gorkie-MIT).
This page records the pre-publication audit and the things that constrain it, so
the next person deciding whether to make the repo public is not re-deriving it.

## The licence is not a clean slate

Kyto began as a fork of **gorkie**, which was MIT-licensed, and this repository
still contains gorkie's full history — the initial commit is gorkie's, and
`upstream` still points at `imdevarsh/gorkie-slack`.

MIT permits relicensing a derivative work under stricter terms, but it does **not**
let anyone withdraw the permissions already granted for the original code. So:

- Kyto's own code is all-rights-reserved (`LICENSE`).
- Gorkie-derived code, and the pre-rewrite history, stays MIT (`LICENSE-gorkie-MIT`),
  and that notice must be retained.
- A blanket "nobody may copy or use any of this" over the whole repository would
  be inaccurate while gorkie's code and history are present.

The current harness is a ground-up rewrite (the Vercel Chat SDK, the Pi framework
and `@ai-sdk/harness*` are all gone), and the surviving fraction has now been
**measured** (2026-07-26, `git blame` line-provenance: a line counts as
gorkie-derived iff the commit that last touched it is reachable from
`upstream/main`):

- **Runtime source is ~16% gorkie-derived**: 4,054 of 24,976 lines —
  3,279/20,076 in `apps/bot/src`, 775/4,900 across `packages/*/src`.
- **The whole tree is ~49%**: 21,178 of 42,983 tracked text lines, because
  scaffolding survives nearly wholesale — turbo/tsconfig/generator config,
  `.vscode`/`.zed`, `plans/rewrite.md`, `README.md`, `TESTING.md`, cspell
  tooling, `packages/logging`, the orphaned `packages/db` sandbox
  schema/queries.
- Files that are still substantially gorkie: `bot.ts` (101/113),
  `agent/reply.ts` (172/213), `agent/turns.ts` (49/49), the whole
  `lib/ai/stream/tasks/` directory, `features/assistant`, and several small
  tools (`get-user`, `get-channel-info`, `list-threads`, `mermaid`).

So the "may be near zero" hypothesis is **disproven**: the MIT carve-out is
load-bearing and `LICENSE-gorkie-MIT` must stay. (Blame attributes an
edited-in-place gorkie line to the kyto edit, so if anything this undercounts
derivation.) **This is not legal advice** — the structure above is the
conservative reading, and a lawyer should confirm it before relying on it
commercially.

Publishing to a public GitHub repo also makes the **whole history** public, not
just the tip. Squashing it away would be the only way to avoid that, and it would
also destroy the audit trail that makes "read the source" meaningful.

## Secrets audit

Checked before publication:

- **No `.env` was ever committed.** The only env files in history are
  `.env.example` (root, `apps/bot`, and the long-deleted `apps/server`).
- **No real credentials in the working tree or in history.** Scanned tracked files
  and every added/modified line across all branches for GitHub tokens (`ghp_`/
  `gho_`/`ghu_`/`ghs_`/`github_pat_`), OpenAI/Anthropic keys (`sk-`, `sk-ant-`),
  Slack tokens (`xoxb-`/`xoxp-`/`xapp-`), Google keys (`AIza…`) and E2B keys.
  Every hit was a placeholder (`sk-ant-api03-not-a-real-key-…`,
  `sk-hc-your-sandbox-hackclub-api-key`, `xoxb-paste-your-token-here`).
- **Database URLs in history are all examples** (`postgres://user:password@`,
  `postgresql://gorkie:gorkie@`, `…:your-strong-password@`). The live Postgres is
  localhost-only with no TLS, so its password is not reachable from outside the
  host anyway — but it is *not* one of the values in history, and should stay that
  way.
- **No real email addresses** in tracked files.
- The only Slack ids in tracked source are **kyto's own bot ids across
  deployments** (`packages/ai/src/prompts/slack.ts`, `.claude/CLAUDE.md`), which
  every member of the workspace can already see.

## Not secrets, but they do identify the deployment

Publishing reveals where and how kyto runs: the Oracle Linux host layout and
service user (`deploy/kyto.service`), the Postgres role name, the bot's app/user
ids, the `gorkie__devansh_` legacy handle, and the full list of env vars it reads
(`apps/bot/.env.example`). None of that is exploitable on its own, and all of it is
load-bearing documentation. Worth knowing it goes public, not worth removing.

## Third-party material

`.agents/skills/` vendors ten skills; `LICENSE` §5 disclaims any claim over the
third-party ones. Provenance is recorded: eight were installed by the `skills`
CLI and are pinned (source repo, path, content hash) in **`skills-lock.json`**;
the other two are first-party. Upstream licences as of 2026-07-26:

| skill | source | licence |
| --- | --- | --- |
| `ai-sdk` | `vercel/ai` | custom/unspecified per GitHub ("Other") — check its LICENSE before redistributing |
| `chat-sdk` | `vercel/chat` | MIT |
| `grill-with-docs` | `mattpocock/skills` | MIT |
| `improve` | `shadcn/improve` | MIT (also stated in its frontmatter) |
| `slack-agent` | `vercel-labs/slack-agent-skill` | Apache-2.0 (redistribution wants the notice) |
| `thermo-nuclear-code-quality-review` | `cursor/plugins` | **no licence detected / repo not resolvable** — re-check or drop before publishing |
| `turborepo` | `vercel/turborepo` | MIT |
| `ultracite` | `haydenbleasel/ultracite` | MIT |
| `coding-best-practices` | first-party (kyto-specific rules) | kyto's LICENSE |
| `refactor` | first-party (kyto-specific cleanup style) | kyto's LICENSE |

Before going public, the two flagged rows (`ai-sdk`, `thermo-nuclear-…`) need
their licence confirmed or the skill dropped; the MIT/Apache ones are fine to
keep with their lock-file attribution.

## Before flipping the repo public

1. Rotate `GH_TOKEN` if it has ever been pasted into a chat, a transcript, or an
   issue. Publishing does not leak it, but publication is a good forcing function.
2. ~~Decide the gorkie-provenance question~~ **Measured (above): keep the MIT
   carve-out — ~16% of runtime source is still gorkie-derived.**
3. ~~Document `.agents/skills/`~~ **Done (above)** — but confirm-or-drop the two
   flagged skills (`ai-sdk`, `thermo-nuclear-code-quality-review`).
4. Re-run the secrets scan on whatever has landed since this audit.
