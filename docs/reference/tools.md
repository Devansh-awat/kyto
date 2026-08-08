---
title: Tools
description: The model-facing tool surface and safety boundaries.
---

Tools live in `apps/bot/src/lib/ai/tools/` and are registered in
`apps/bot/src/lib/ai/toolset.ts`. There are two kinds: **sandbox tools**, which
act on this thread's E2B workspace, and **host tools**, which the bot process
runs itself.

This page is the shape of the surface. The per-tool detail — arguments, gating,
and the failure each gate exists to prevent — lives next to the code in
[`.claude/TOOLS.md`](https://github.com/Devansh-awat/kyto/blob/main/.claude/TOOLS.md),
which is kept current with the roster.

## Core And Deferred

Only a core set is visible to the model on every turn. Everything less common —
the browser, email, GitHub, canvases, polls, TTS, subagents, and every per-user
MCP tool — is registered but hidden until the model calls the **`loadTools`**
meta-tool, which is enforced per step. That keeps ~40 tool schemas out of the
prompt without taking the capability away.

Whether it is worth it is measured, not assumed: every turn logs a
`[tools] turn summary` with what was loaded, what was used, and what was loaded
and never called.

## Sandbox Tools

| Tool | Purpose |
| --- | --- |
| `bash` | Run a shell command in the E2B workspace. |
| `readFile` / `writeFile` / `editFile` | Work with files in the workspace. |
| `codeMode` | Run ONE TypeScript program instead of N tool round-trips. |
| `runBackgroundProcess` / `getProcessOutput` / `killProcess` | Long-running work that must not hold up the turn. |
| `viewImage` | Put an image from the workspace into the model's vision. |

The sandbox persists for the thread: it is paused when a turn ends and resumed
on the next one, so files and installed packages survive.

## Slack Tools

| Tool | Purpose |
| --- | --- |
| `readConversationHistory`, `listThreads`, `summarizeThread` | Read channel and thread history. |
| `searchSlack` | Search through Slack's assistant search context. |
| `slackScript` | Run a bash script that batches READ-ONLY Slack API calls. |
| `postMessage`, `react`, `poll`, `askQuestion` | Speak or ask in Slack. |
| `getUser`, `getChannelInfo`, `createChannel`, `setChannelTopic` | People and channels. |
| `canvas*`, `pins`, `bookmarkLink` | Slack surfaces beyond messages. |
| `sendAsUser` / `editAsUser` | Post as the owner's own account. Owner-only, always behind a confirm click. |

The streamed assistant text is already the reply to the current message. The
model does not call a posting tool to answer the message it is answering.

## Everything Else

| Tool | Purpose |
| --- | --- |
| `searchWeb`, `fetchUrl`, `browser` | The web, including a real headful browser. |
| `gh`, `githubAccess` | GitHub, through the host-side proxy. |
| `sendEmail`, `checkInbox`, `readEmail`, `replyEmail` | Kyto's mailbox. |
| `generateImage`, `mermaid`, `textToSpeech`, `uploadFile`, `getFile` | Make and move files. |
| `scheduleReminder`, `deploySite`, `memory` | Reminders, hosted sites, saved memories. |
| `subagent`, `upgradeModel`, `wait`, `skip`, `focusMode` | Turn control. |

## Safety Boundaries

These are invariants, not conventions:

- **A sandbox holds no credentials.** The Slack token and the GitHub PAT stay on
  the host. Sandboxed code reaches Slack only through a READ-ONLY allow-listed
  proxy, and GitHub only through a proxy that classifies each request and
  applies the write gate itself.
- **Sandboxed code cannot invoke a mutating tool.** There is no RPC bridge back
  to the host tools, so an injected instruction cannot script an outward send.
- **Outward-facing posts need a human click.** A cross-channel or DM post, a
  post wearing someone's face, and every send-as-the-owner stash the pending
  message and wait for a Confirm button, pressed by the person entitled to
  approve it.
- **Broadcast pings are denied by default** and are owner-gated and
  channel-local when allowed at all.
- **GitHub writes are gated on who owns the repo**, enforced at execute time in
  every tool that is a shell.
- **Email read paths strip credentials before the model sees them** — reset
  links, magic links, and OTP codes — with no exception for the owner.

## Rendering

Every visible tool should have a task renderer under
`apps/bot/src/lib/ai/stream/tasks`. A task row says what happened; it does not
dump raw JSON. A tool result carrying an `error` renders as a completed row with
the error in bold — it does not fail the turn.
