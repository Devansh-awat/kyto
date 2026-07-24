# AI tools — per-tool detail

> Split out of `.claude/CLAUDE.md` to keep that file under its 40k budget. **Not
> loaded automatically** — read this before touching a specific tool, and keep it
> current the same way (durable *what and why*, no post-mortem narrative). The
> tool list, registration path, and the security invariants that must never
> regress stay in CLAUDE.md.

Tools live in `apps/bot/src/lib/ai/tools/`, registered in `lib/ai/toolset.ts`. Raw Slack API: `slack.webClient.apiCall(method, args)`; error helpers `errorMessage()`/`toLogError()` from `@/lib/utils/error`.

## Code Mode

`codeMode` (core, `tools/code-mode.ts`) is Cloudflare's [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) pattern: instead of one host tool per step (each a model round-trip that can 429 or exhaust the step budget), the model writes **ONE TypeScript program** doing the whole multi-step job and prints its result. Runs in the thread's persistent sandbox via `bun`. The script can `import { sh, slack } from './kyto.ts'` (shell + the READ-ONLY Slack proxy), use `fetch`, and drive `cloakbrowser`. `install` pre-`bun add`s deps. This is the answer to "50 browser round-trips" — script the loop.
- **Security boundary**: sandboxed code reaches only what sandbox code already safely reaches — shell, network, read-only Slack. It deliberately CANNOT invoke kyto's mutating/outward tools (postMessage, sendAsUser, …); those stay behind the confirm-post human gate so a prompt injection can't turn a script into an outward send. Do NOT add a host-tool RPC bridge for mutating tools without a confirm gate.

## Vision (kyto can see images)

kyto genuinely SEES images. **The only channel that works is a USER message**: the openai-compatible providers JSON-stringify tool-result content, so an image returned from a tool is dropped to text; a user-message image part converts to `image_url` and IS seen. So both vision paths land as user-message file parts.
- **Attachment images** (`seedAttachments` keeps `imageBytes` for png/jpg/webp/gif ≤8MB) pass to `streamAttempt` as `images` and ride in the user turn (before the text, so the cache breakpoint stays on the trailing text).
- **`viewImage`** (`tools/view-image.ts`) lets the model look at a sandbox image (a screenshot, a generated/downloaded image). It buffers the bytes (`buildTools` → `drainImages`); `streamAttempt`'s `getFreshImages` is drained in `prepareStep`, appending the image as a **user message** for the next step (carries forward). `readFile` returns text — the sandbox prompt tells the model to `viewImage` instead of assuming it's blind.
- The **primary Kimi has the MoonViT vision encoder**, so no vision-specific routing is needed. Both the main loop and the subagent get `getFreshImages`.

## Memory (workspace-global)

`saveMemory`/`fetchMemory`/`editMemory` (core, `tools/memory.ts`; `memories` table; `@repo/db` `listMemoryIndex`/`getMemory`/`createMemory`/`updateMemory`). Durable notes kyto writes for ITSELF after solving a big/non-obvious task, so a LATER thread reuses the solution. **Workspace-global, not per-user.** Every memory's `title` + one-line `summary` is injected into the system prompt as a `<memories>` block (`RequestHints.memories`, rendered in `prompts/context.ts`); the model calls `fetchMemory("<title>")` to pull the full `body` only when relevant. `saveMemory` is create-only (title unique; a clash tells the model to edit); `editMemory` patches in place. **There is deliberately NO delete tool** — the knowledge base only grows. Titles are the handle; keep them stable.

## Host-side tools and sandbox specifics

- **`gh`** (deferred, needs `GH_TOKEN` on host): GitHub CLI in the turn's sandbox. The real token is **brokered via E2B egress rules** and is **never in the sandbox** — `LazySandbox` sets `network.rules` that inject the `Authorization` header on outbound requests to `api.github.com`/`uploads.github.com` (Bearer) and `github.com` (Basic) at the proxy layer; the sandbox env holds only a placeholder. So `gh`/`git` are pre-authenticated but `echo $GH_TOKEN` reveals nothing. Needs e2b ≥2.31 for `SandboxNetworkOpts.rules`.
- **`bash` auto-backgrounds a slow command** (`tools/sandbox.ts` + `tools/background.ts`): a foreground command still running after **60s** (`AUTO_BACKGROUND_MS`) is moved to the background instead of freezing the turn — the tool returns a handle (`bg-N`, `running: true`) and the model polls via `getProcessOutput`/`killProcess`. Every command runs detached (nohup, separate stdout/stderr/exit files), polled up to 60s; a fast command returns transparently. `bash` shares the **one** `backgroundProcessTools` registry (built before `core` in `toolset.ts`). Handles are per-turn (in-memory).
- **`wait`** (core): a bounded, abort-aware mid-turn pause, up to **1 hour**. It calls `extendAttemptDeadline` (threaded from `agent/index.ts` through `buildTools`) so the watchdog treats a long pause as work, not a stall. `pauseSandbox: true` suspends the sandbox (`session.destroy()` pauses a persistent sandbox; the next command auto-resumes) — ignored under 120s; suspends background processes too.
- **`writeFile`** takes `append`. One tool call can't carry a very large file (its args ride in the model's token budget), so the description tells the model to chunk a big write (`append:false` then `append:true`).
- **`fetchUrl` rejects Slack links** (`isSlackLink`): a `*.slack.com` URL 302s to a login wall, so it refuses and points to the Slack read tools (readConversationHistory for a message — path `/archives/<CHANNEL>/p<TS>`; getFile for a file).
- **`getFile` sends the bot token ONLY to Slack hosts** (`isSlackFileHost`): the download carries `Authorization: Bearer SLACK_BOT_TOKEN`, so the resolved URL must be `files.slack.com`/`*.slack.com`/`slack-files.com` over https — any other URL is refused before the header is attached. Do NOT restore an arbitrary-URL passthrough: a prompt injection once used it to mail the bot token out in the auth header. Non-Slack URLs go through `fetchUrl` or the sandbox.
- **Email** (`tools/email.ts`) runs **host-side** via the AgentMail SDK using `AGENTMAIL_API_KEY`; registered only when that key is set. Not in the sandbox.
- **Image generation** (`tools/generate-image.ts`) calls HackClub's `/images/generations` directly (`google/gemini-3.1-flash-image`), parsing `data[].b64_json`. The AI SDK `generateImage` path never reached the endpoint — don't go back to it.
- **Sandbox git safety** (`packages/sandbox/src/git-safety.ts`, wired in `lib/sandbox/git-safety.ts`): a repo that arrives as an archive/clone carries executable config with it. Every materialization runs `GIT_HARDEN_COMMAND` (global `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `protocol.ext.allow=never`), and after any tool call that could have fetched a repo (`mayHaveFetchedRepo` — tar/unzip/curl/clone/…) `sanitizeGitRepos` deletes every `.git/hooks/*` and strips the command-executing keys from each repo config (`core.hooksPath`/`fsmonitor`/`sshCommand`/`pager`/`editor`, `diff.external`, `include.path`, and the `[filter "x"]`/`[diff "x"]`/`[alias]`/`[credential]`/`[includeIf]` sections). Repo-local config is the reason the sweep exists at all: it would otherwise override the global hook path. Runs from `bash`, `gh`, and background processes (on the poll that first sees them finish).
- **Web search** (`searchWeb`) uses Exa via `EXA_API_KEY`. The placeholder key (`exa-placeholder-no-websearch`) returns `ExaError: Invalid API key`.

## Browser

`browser` (`tools/browser.ts`, deferred) runs the preinstalled `agent-browser` CLI **inside the sandbox** (pass CLI args in `command`; run `skills get core` first). It drives **CloakBrowser** (`lib/browser/cloak.ts`, `ensureCloakBrowser`), a Chromium with ~66 source-level C++ fingerprint patches (canvas, WebGL, audio, fonts, GPU, WebRTC, automation signals), so anti-bot systems score it as ordinary and **most sites never serve a challenge**. It does NOT solve captchas — it prevents them. Every call first runs an idempotent ensure script: exit if CDP on :9222 answers, else install `cloakbrowser`, launch it **headful under Xvfb** (headless gets flagged; falls back to `--headless=new` if Xvfb won't install) with `--fingerprint-platform=windows`, then `agent-browser connect 9222`. A pause kills the Chromium but keeps the cached binary. `cloakbrowser` + `xvfb` are baked into the E2B template.

If a captcha DOES appear, the tool/prompt tell the model to snapshot the page and **click the checkbox like a person** — never to claim it can't before trying. **Scripting it directly**: the sandbox prompt says `cloakbrowser` is a real npm package (a stealth Chromium, drop-in Playwright/Puppeteer replacement), so for a loop or scheduled job the model writes a Node script against it. The **headful rule** applies there too: run under `xvfb-run -a node script.js` with `fingerprintPlatform: 'windows'`, or it gets flagged.

## Subagent

`tools/subagent.ts` — a headless copy of kyto: **shares the parent turn's sandbox** (`getSandboxContext` from `toolset.ts`), the full toolset, driven by the same `streamAttempt` loop, returning its final text as a report. Deferred; registered only when a subagent model exists.
- **Nesting is ONE level** (`MAX_SUBAGENT_DEPTH = 1`).
- **It must NOT create or destroy the sandbox** — the parent owns the lifecycle. The subagent's `finally` only closes per-turn tool/MCP connections.
- **Model roster + report fallback** (`subagentAttempts`, `providers/attempts.ts`): cheap Gemini `gemini-3.1-flash-lite` first, then the DigitalOcean roster. The subagent **walks this list** on an error OR an empty report (one pinned cheap model made a "herd" of subagents report nothing). If a model ran tools but wrote no prose, `synthesizeReport` re-asks THAT model once with **tools off**.
- **Report to parent**: the foreground path returns `{report, success:true}` as the tool RESULT.
- **Background + `checkSubagent`** (`background: true`): registers the job in an in-turn registry (ids `sub-1`…) and returns immediately. `checkSubagent`: no id → lists all; with an id → status + report once done; `wait: true` blocks. Per-turn registry (like bash background processes).
- **It posts its OWN streamed message** — a second `slack.stream` authored "kyto subagent" (+ optional `name`). Renders like a real turn (shared `renderStream`) with a **Prompt** card, a **Model** card per attempt, and a **Response** card. Everything lives inside the one collapsible plan; response captured via `onTextDelta` (no `emitText`).
- Runs on a slimmer prompt (`subagentSystemPrompt`): a lean `<subagent>` core + sandbox + context, without personality/tone, the custom-instruction hierarchy, broadcast etiquette, or media/copyright framing. Keeps finish-the-job, parallel-tool, loadTools, private-auth, SFW, report-back guidance.

## Recurring reminders

`tools/reminders.ts`, `lib/reminders/scheduler.ts`, `@repo/db` `reminders`. Unlike the one-time `scheduleReminder` (Slack's native `chat.scheduleMessage`), recurring reminders are driven by kyto's own always-on process (Slack has no recurring-schedule API). A row holds `user_id`, `text`, `recurrence` (`interval`|`daily`|`weekly`) plus schedule fields, `next_run_at`, `channel_id` (fire into a channel vs DM — **owner-only**, same gate as cross-channel posting), `max_runs`/`run_count`, `thread_id`, `kind`, `editor_user_ids`. `startReminderScheduler` polls every 30s and posts each due reminder, then advances `next_run_at`. Posts honor the reminder identity profile; a channel-targeted reminder prefixes `<@user>`.

**Kinds** (`reminders.kind`) + interval floors:
- `message` (default, 60s): posts `text` verbatim.
- `script` (60s): fetches `url` each fire and posts its content (`fetchUrlText`).
- `bash` (5 min; `lib/reminders/bash.ts`): runs `command`, posts stdout/stderr, **in the persistent sandbox of the thread it was created in** — so it can run a script kyto wrote earlier. A row without `thread_id` falls back to `runOnce` (throwaway sandbox, empty every fire).
- `agent` (1 hour; `lib/reminders/agent.ts`): runs a **headless kyto** (same loop, full toolset, nothing streamed) with `text` as instructions and posts the final reply. Pinned to the cheap subagent model. Reuses the thread's sandbox. `searchSlack` does NOT work here (its action token needs a live interaction).

Tools: `scheduleRecurringReminder`, `listReminders`, `pauseReminder`, `resumeReminder`, `cancelReminder`, `editReminder` (only the fields passed are touched; a new schedule takes effect from now; a bare `intervalSeconds` is re-floored against the kind). An **App Home "Reminders"** section lists each reminder a user may act on with Pause/Resume/Delete.

The scheduler fires due reminders **concurrently** and guards **overlapping fires** with an in-flight `Set` — a row is advanced only *after* it fires (else a multi-minute run restarts every poll). `advanceReminder` computes the next run from `max(nextRunAt, now)`, so a schedule left in the past doesn't re-fire every poll.

## Slack search

`assistant.search.context` runs with the **requesting user's** own Slack access, so it reaches private channels/DMs that user is in — but only with granted scopes (`search:read.public`/`.files`/`.users`/`.private`/`.im`/`.mpim`; the last three were missing once, silently limiting every search to public channels).
- **Cost**: returns `limit: 10` matches with `include_context_messages: true`; those context messages dominate input tokens and ride along in every subsequent step (a turn can balloon to 100k–270k tokens). We trim each match to the **2 nearest before + 2 after**. Drop `limit` or trim further if cost climbs.
- **Modifiers**: the `query` supports Slack's full search-bar set, combinable — `from:`, `to:`, `in:` (`#channel` or `@user`), `on:`/`before:`/`after:`/`during:`, `has:link`/`star`/`pin`/`:emoji:`, `is:thread`/`dm`/`external`, `filename:`, `ext:`. In the tool description + core prompt so the model narrows queries.
- **Action-token urgency**: the `action_token` expires ~2 min after the turn starts, so the core prompt tells the model to run all `searchSlack` calls early.

## Slack read-only scripting (host-side proxy)

`slackScript` (deferred, gated on `SITES_ENABLED`) runs a bash script for **aggregate** Slack questions in one script instead of N tool round-trips. It POSTs to a **host-side, secret-gated, READ-ONLY proxy** on the sites server at `/_slackapi/<method>` (`lib/slack-proxy/`). The **bot token never enters the sandbox**: the proxy attaches the real token and forwards ONLY the `READ_ONLY_METHODS` allowlist (users.*, conversations.*, team.*, usergroups.*, reactions/pins/bookmarks list, emoji.list). (Our bot token isn't itself read-only, which is why it can't just be handed to the sandbox.)

**`slack` is a real executable on PATH**: `slackHelperInstall()` is `LazySandbox`'s `bootstrapCommand`, run each time a sandbox materializes (create AND resume — must stay idempotent). So the plain `bash` tool and a `bash` reminder can query Slack read-only too. The helper reads `KYTO_SLACK_PROXY[_TOKEN]` **from the environment at call time** and `run()` re-sends env on every command — that's what lets a *persistent* sandbox outlive any single turn's token, and why a **`bash`/`agent` reminder mints a fresh proxy token at fire time and revokes it after**. No search method is in the allowlist, so "count a user's messages" means paging `conversations.history` per channel (slow, not a bug). A subagent shares the parent's sandbox, so `slackScript`/`codeMode`/`slack` work inside it too.

## Focus mode

`focusMode` (core) locks kyto onto specific user ids in the current thread: it only replies to those users AND their messages are the only ones it **sees** — non-focused messages are filtered out of the prompt (`isFocusAllowed`, `lib/agent/focus.ts`), so others can't hijack it in a public thread. The **owner is always allowed through** and kyto's own messages always stay in context. Gated in `bot.ts`; persisted on `thread_subscriptions.focus_user_ids`. `clear: true` turns it off.

## Canvases and pins

- `canvasList` takes an optional `channelId`; on `not_in_channel` it joins the public channel **silently** and retries.
- `canvasWrite` create modes accept `title`. `create-channel` best-effort **adds the canvas as a channel tab** by bookmarking its permalink (`addCanvasTab`). Needs `bookmarks:write` + `files:read`.
- `pinMessage`/`unpinMessage` take an optional `channelId` and `as: 'bot' | 'user'`. As the bot, `not_in_channel` triggers one `conversations.join` + retry. `as: 'user'` pins as the owner via `SLACK_USER_TOKEN` and is owner-gated. Needs bot `pins:write` and, for `as:'user'`, the user-scope `pins:write`.

## Static site hosting

`deploySite`/`removeSite`/`listSites` publish static sites at `https://<host>/<name>/` (default host `kyto.devansh.hackclub.app`). Code in `lib/sites/`. The host **never executes site code** — building/testing happen in the E2B sandbox; only static output is copied out (`resolveWithin` path containment). Both tools take an optional `page` sub-path (`docs/intro`), served at `/<name>/<page>/`, validated by `isValidPagePath`; a page deploy atomically swaps only that sub-path. The server starts from `apps/bot/src/index.ts` (`startSitesServer`) and serves **plain HTTP** by default (it sits behind Nest's TLS-terminating proxy; serving HTTPS there → 502); `SITES_TLS=true` for a self-signed cert standalone. Config: `SITES_ENABLED`, `SITES_PORT` (8080), `SITES_TLS`, `SITES_ROOT` (`/var/kytosites`), `SITES_PUBLIC_HOST`.

## Ownership & edit permission (reminders + sites)

Things kyto creates on someone's behalf and can later change carry an access list, so a bystander in a public thread can't rewrite someone's reminder or take down their site. The rule, shared by both: **the creator, anyone the creator named as an editor, and the bot owner.** The core prompt tells the model the rule, and that a refusal is not to be worked around.
- Set at creation via optional **`editors`** on `scheduleRecurringReminder` and `deploySite` (user ids or `<@U123>`; `parseEditors` in `tools/editors.ts` rejects anything that isn't a user id, so a display name can't become a permission entry that never matches). Omitted = creator only.
- Enforced **at execute time against `message.author.userId`** — the person actually talking this turn, not whoever the model claims to act for. Reminders: `isReminderEditableBy` + `editableBy` (a jsonb `@>` check) scope every list/pause/resume/cancel/edit. Sites: `checkSiteAccess` + `canEdit`.
- Storage: `reminders.editor_user_ids` (jsonb) and the `sites` table (`name` PK, `owner_user_id`, `editor_user_ids`). First deploy of a name **claims** it; a whole-site `removeSite` releases it, removing one `page` does not. Sites published before the table existed have no row — `siteExistsOnDisk` makes them bot-owner-only.
