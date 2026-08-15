# Operations

> Split out of `.claude/CLAUDE.md` to keep that file under its 40k character
> budget. **Keep this current the same way** — if you change how kyto is
> deployed, synced, debugged, or migrated, update it in the same change.

## Manifest sync

`bun run sync:manifest` (apps/bot) pushes `slack-manifest.json` via `apps.manifest.update`. Needs a Slack **app configuration token**, not the bot/user token: `SLACK_APP_ID`, `SLACK_CONFIG_ACCESS_TOKEN`, optional `SLACK_CONFIG_REFRESH_TOKEN`. Scopes live in `slack-manifest.json` — update it when a tool needs a new one; scope changes require reinstalling the app.

## Host / deployment

- **Runs as a Coolify-managed Docker container on the `oracle` server** (Oracle Linux 9, aarch64; migrated from bare systemd to Coolify 2026-08-15 — `kyto.service` is masked, not deleted, in case of rollback). Coolify itself lives at `coolify.devansh.dino.icu` on the same box.
- **Postgres is local to the host, no TLS.** Inside the container, `127.0.0.1` is the container itself, not the host — so `DATABASE_URL` (set in Coolify's app env, not in this repo) points at Coolify's Docker bridge gateway IP instead. Postgres was opened up for this via two host-level changes (neither lives in this repo, so a fresh host needs them redone): a `pg_hba.conf` rule scoped to the `gorkie` user, `gorkie` db, and Coolify's docker subnet only (not open beyond that), and `listen_addresses = '*'` in `postgresql.conf`. `packages/db/src/client.ts` keeps `ssl: false` — do not change.
- **Build/start commands live in Coolify's application config, not in this repo.** Install is `bun install --ignore-scripts`: the root `prepare: lefthook install` script fails during a Docker build (the image has no `.git` dir, so `lefthook install` can't find a git repo to hook into), which would otherwise fail the whole install step. `--ignore-scripts` skips all lifecycle scripts repo-wide — currently safe since `prepare` is the only one anywhere in this monorepo (checked all workspace packages), but re-check if any package ever adds its own `postinstall`. Start command is `bun run --cwd apps/bot start` (base directory is the repo root, so bun can resolve the workspace packages). None of this is captured in a `nixpacks.toml`/Procfile in-repo, so a fresh Coolify deploy of this repo needs these set manually.
- **Push to `main` auto-redeploys** via a GitHub webhook (`repos/Devansh-awat/kyto/hooks`) → Coolify's `/webhooks/source/github/events/manual`, HMAC-verified with a per-application secret Coolify generated. No manual redeploy step needed for a normal change.
- **`gh` is NOT in the Oracle Linux repos**; install it from GitHub's official RPM repo, or authenticate git pushes with a PAT credential instead.

## Debugging "kyto isn't responding"

- Runs as a **Coolify-managed Docker container** — there is no host process to `systemctl restart` anymore (`kyto.service` is masked). Logs: Coolify dashboard → kyto → Logs, or `docker logs <container-name>` on the oracle server (container name changes per deploy — `docker ps --filter name=kyto` or check the Coolify dashboard for the current one). Two unrelated Slack apps run alongside it as separate Coolify apps (`slack-ai-helper`, `hackclub-ai-status-bot`) — different tokens, no interference.
- **Never hand-launch a second copy, on the host or anywhere else.** Each process opens its own Socket Mode connection and Slack delivers each event to only ONE, so a stray instance silently steals ~half the mentions. Diagnose with the `hello` frame's `num_connections` (throwaway socket via `apps.connections.open`) — should be **1**.
- **Slash commands work but @mentions/DMs don't = Event Subscriptions are off.** Socket Mode routes slash commands, interactivity, and events independently; if the **Enable Events** master toggle is off (it silently turned off once), `slash_commands` still deliver while events deliver nothing. Re-enable it.
- **Zombie socket**: a dropped WSS can stay TCP-`ESTAB` with a stuck send-queue (`ss -tnp | grep :443` shows non-zero Send-Q) while delivering nothing. Restarting the container fixes it — push a no-op commit, or trigger a redeploy from the Coolify dashboard (kyto → Redeploy).

## Branches

**`main` is the branch actually deployed** (`kyto.service` tracks what's checked out here). `rebuild-on-upstream` is a dead Pi-era branch — `main` is a strict superset (audited 2026-07-09), except its `MAX_RECURRING_RUNS = 20` auto-cancel, deliberately NOT ported (it would silently kill existing "forever" reminders).

## Database notes

New tables/columns are pushed with one-off SQL — `drizzle-kit push` prompts interactively (a rename decision) and hangs in a non-TTY shell. Use `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`; `db:generate`/`db:push` work for a human at the CLI. `authorization` is reserved — quote it in DDL. `sandbox_sessions` is **orphaned scaffolding**; `thread_sandboxes` is live.

## Owner dashboard

`lib/dashboard/`, mounted on the **sites** Bun.serve at **`/_dashboard`** (shares `SITES_PUBLIC_HOST`; the sites name regex can't produce `_dashboard`, so no collision). Server-rendered HTML, no client framework or external assets.

- **Gated on `DASHBOARD_PASSWORD`** (min 12 chars). Unset = the route returns null and the sites server falls through, as if never mounted.
- One password stands between the public internet and a privilege grant: constant-time compare, **global lockout after 8 failures** (one legitimate user, so a global lock costs nothing and no per-IP bookkeeping can be spoofed), in-memory sessions (12h), `HttpOnly; Secure; SameSite=Strict` cookie, **per-session CSRF token on every mutation**.
- Two jobs: **promote a memory to global** (read the body first — it becomes prompt text on everyone's turns) and **grant/revoke GitHub trust**, incl. queued `github_requests`.
- **Approving a GitHub request grants trust and stops there** — it does NOT replay the command (composed by a model in a thread that has since moved on; re-running it blind turns a click into an action nobody reviewed). The person asks kyto again.

## The `banned_users` table (2026-08-14)

```sql
CREATE TABLE IF NOT EXISTS banned_users (
  user_id text PRIMARY KEY,
  reason text NOT NULL,
  expires_at timestamptz,
  banned_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

One row per banned user, replaced on a re-ban and deleted on an unban — a ban is
a current state, not a history, so there is deliberately no record of who has
ever been banned. `expires_at` null means indefinite; an expired row simply stops
applying (`listBans` filters on it), so nothing sweeps it.
