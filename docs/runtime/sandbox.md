---
title: Sandbox
description: E2B lifecycle, per-thread persistence, and how it reaches Slack and GitHub.
---

Each Slack **thread** gets its own E2B Linux workspace. The agent loop runs on
the bot host and uses the sandbox for file and shell operations, through the
`bash`, `readFile`, `writeFile` and `editFile` tools plus the host tools that
opt in (`browser`, `deploySite`, `getFile`, `uploadFile`, `codeMode`).

Configuration lives in `packages/sandbox/src/config.ts`.

## Lazy

`LazySandbox` defers `Sandbox.create` until a tool actually touches the sandbox,
so a chat-only turn costs no E2B time at all.

## Persistent Per Thread

Ending a turn **pauses** the sandbox rather than killing it. The thread's
`sandbox_id` is remembered in `thread_sandboxes`, and the next turn connects to
the same id — it auto-resumes in around half a second, with the same filesystem.
That is what makes a recurring `bash` reminder useful: write and test a script
once, then schedule it, and every fire runs in the same box.

- A **thread**, not a "conversation": every message roots its own thread, so a
  new top-level DM gets a new sandbox.
- Persistence is opt-in through an injected `SandboxStore`, so
  `packages/sandbox` stays free of the database.
- The create-time environment is stale on a resumed sandbox, so per-command env
  is re-sent on every run. That is how short-lived proxy tokens stay fresh.
- One sandbox is one mutable machine, and a live turn and a scheduled job can
  both reach for it, so access is serialized per thread.
- A paused sandbox costs storage, so an hourly reaper kills anything untouched
  for 30 days. It is **activity**-based, so a sandbox kept warm never ages out.
- There is ONE shared virtual display (`kyto-display` on PATH). The headful
  browser needs X, and letting each caller start its own left stale locks that
  broke every later start.

## Reaching Slack And GitHub

No credential enters the sandbox.

- **Slack**: a `slack <method> '<json>'` command on PATH posts to a host-side
  proxy that forwards only allow-listed READ-ONLY methods and attaches the bot
  token itself. Even a leaked per-turn proxy secret can never post or delete.
  It is on PATH, not injected as a shell function, so the plain `bash` tool and
  a scheduled reminder can use it too. Run `slack --help` in the sandbox for the
  usage and the method list.
- **GitHub**: `gh` and `git` are pointed at a host-side proxy that speaks the
  GitHub Enterprise API shape. The host classifies each request, applies the
  write gate, and attaches the PAT. A bare `curl api.github.com` from inside the
  sandbox is anonymous.

A git repo that lands in the sandbox is disarmed by code, not by asking the
model: hooks are disabled globally and stripped per repo, and command-executing
config keys are removed.

## Template Build

Build the E2B template when sandbox runtime dependencies change:

```sh
bun run build:template
```

The build script loads `apps/bot/.env` through `dotenv`, so `E2B_API_KEY` stays
out of tracked files.
