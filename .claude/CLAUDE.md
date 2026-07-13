# Code standards

**Ultracite** (a Biome preset) enforces formatting and lint. Run `bun x ultracite fix` before committing; `bun x ultracite check` to lint. It auto-fixes most style issues, so spend your own attention on business-logic correctness, naming, architecture, edge cases, and UX instead.

House style beyond what Biome catches: explicit types where they aid clarity and `unknown` over `any`; `const` by default; `for...of` over `.forEach()`; early returns over nesting; named constants over magic numbers; `Error` objects with real messages; no `console.log`/`debugger` in production; no barrel files; validate input.

---

# Project Notes (Kyto Slack bot)

> **Keep this file current.** When you add, remove, or change a feature (an agent
> tool, a scope, a config flag, a gating rule), update the relevant note in the
> SAME change, proactively. Stale notes are worse than none.
>
> **This file has a 40k character budget.** It has blown past it before. When you
> add a note, keep it to the durable *what and why* — delete the post-mortem
> narrative and any "[historical]" detail that no longer describes live code.

> **Build features FULLY, not minimally.** A new tool isn't just its happy path —
> think through creation, editing, removal, listing, ownership/permission gating,
> persistence across restarts, and how the model manages it. If a dimension
> genuinely shouldn't exist, say why; don't silently omit it.

## After every change (auto workflow — private repo, all pre-authorized)

Run these automatically after each completed change, **without asking**:

1. **Commit** locally, conventional-commit message, docs updated in the same commit. One logical change = one commit.
2. **Sync the Slack manifest** if `slack-manifest.json` changed: `bun run sync:manifest` from `apps/bot`. (Scope changes still need an app reinstall.)
3. **Restart the bot**: `systemctl restart kyto.service`. Check with `systemctl status kyto.service` / `journalctl -u kyto.service -n 30 -o cat` (look for `kyto (…) is online`). **Never hand-launch `bun run start:bot`** — a second process opens a second Socket Mode connection and silently steals ~half the events. If `deploy/kyto.service` itself changed, `systemctl daemon-reload` first.
4. **Push to `origin`** (`github.com/Devansh-awat/kyto.git`).

- **NEVER push to `upstream`** (`imdevarsh/gorkie-slack`, the fork source).
- **Opening a PR still asks first.** Commit/restart/sync/push-to-origin do not.

## Architecture — fully custom harness

The Vercel Chat SDK, the Pi agent framework, and `@ai-sdk/harness*` were removed in a ground-up rewrite. Kyto now runs on:

- **Custom Slack harness** (`apps/bot/src/harness/`) — `@slack/socket-mode` + `@slack/web-api` directly. `SLACK_APP_TOKEN` is required (Socket Mode is the only mode).
  - `SlackHarness` (`harness.ts`): Web API facade. Thread-id codec `slack:CHANNEL[:TS]`, message building, fetch/history/listThreads, reactions, assistant status, native streaming via `webClient.chatStream` (task cards use `task_update` chunks, `task_display_mode: 'plan'`).
  - `KytoBot` (`bot.ts`): owns the Socket Mode connection and event routing (`onNewMention`/`onDirectMessage`/`onSubscribedMessage`/`onAction`/`onModalSubmit`/`onAppHomeOpened`/`onMemberJoinedChannel`). `app_mention` events are deliberately **ignored** — everything routes off `message` events (mention = text contains the bot id), which is what killed the old dedupe problem.
  - `ThreadHandle` (`thread.ts`): `post` (Block Kit `markdown` blocks; files via `filesUploadV2`; per-message profile overrides via `username`/`iconUrl`/`iconEmoji`, needs `chat:write.customize`), `postEphemeral`, `schedule`, `subscribe`/`setState` (own `thread_subscriptions` table + 30s cache), `fetchMetadata`.
  - **Every message threads** — a top-level DM/channel message roots its own thread (`threadTs = event.thread_ts || event.ts`). `buildPrompt` scopes context to that thread only, so kyto has no memory of the rest of a DM by default; it uses `searchSlack` (`in:@user`) to pull earlier history on purpose.
  - Markdown conversion is ours (`harness/markdown.ts`): inbound mrkdwn→markdown, `healMarkdown` closes dangling fences in chunked replies. `bot.getState()` is an in-memory TTL KV (`harness/kv.ts`) — fine, since everything in it is rebuilt at startup.

- **Custom agent loop** on `ai`'s `streamText` (`packages/ai/src/agent.ts` `streamAttempt` + `apps/bot/src/lib/agent/index.ts`): multi-step tool loop (`stopWhen: stepCountIs(60)`), per-attempt `@ai-sdk/openai-compatible` provider. A per-provider `fetch` in `streamAttempt` tunes each request (see Models). `renderStream` (`lib/ai/stream/`) consumes `result.fullStream` and renders the plan.

- **Sandbox tools are ours** (`lib/ai/tools/sandbox.ts`): `bash`, `readFile`, `writeFile`, `editFile` run against `LazySandbox` — E2B `Sandbox.create` happens on the FIRST tool call that needs it, so chat-only turns cost zero E2B.

- **Deferred tools**: uncommon tools (browser, email trio, canvasDelete, createChannel, setChannelTopic, bookmarkLink, pins, poll, mermaid, sendAsUser/editAsUser, gh, TTS, subagent, and all MCP tools) are registered but hidden from the model until it calls the **`loadTools`** meta-tool. Enforced per step via `streamText`'s `prepareStep`/`activeTools` (`buildTools` returns `{tools, activeTools, close}`).

- **Per-user MCP servers** (`lib/ai/mcp.ts`, `user_mcp_servers`): users add remote Streamable-HTTP MCP servers from the **App Home** tab. A hand-rolled JSON-RPC client (initialize / tools/list / tools/call; SSE parsing; no legacy SSE-only transport) connects lazily per turn; listings cached 10 min per URL; tools namespaced `mcp_<server>_<tool>` and deferred behind `loadTools`. A dead server degrades only that turn's toolset. Local (user-machine) MCP servers are impossible over Slack by design.

## AI tools

Tools live in `apps/bot/src/lib/ai/tools/`, registered in `lib/ai/toolset.ts`. Raw Slack API: `slack.webClient.apiCall(method, args)`; error helpers `errorMessage()`/`toLogError()` from `@/lib/utils/error`.

Fork-added: `canvasRead/Write/List/Delete`, `pinMessage`/`unpinMessage`, `bookmarkLink`, `createChannel`, `setChannelTopic`, `poll`, `getPermalink`, `fetchUrl`, `deploySite`/`removeSite`/`listSites`, `skip`, `sendAsUser`/`editAsUser`, `browser`, `sendEmail`/`checkInbox`/`replyEmail`, `joinThread`/`leaveThread`, `focusMode`, `slackScript`, the reminder set, `gh`, `runBackgroundProcess`/`getProcessOutput`/`killProcess`, `wait`, `deleteFile`/`fileStat`, `textToSpeech`, `unreact`, `runSubagent`/`checkSubagent`.

- **`gh`** (deferred, needs `GH_TOKEN` on the host): GitHub CLI in the turn's sandbox. The real token is **brokered via E2B egress rules** and is **never in the sandbox** — `LazySandbox` sets `network.rules` that inject the `Authorization` header on outbound requests to `api.github.com`/`uploads.github.com` (Bearer) and `github.com` (Basic) at the proxy layer; the sandbox env holds only an inert placeholder. So `gh`/`git` are pre-authenticated but `echo $GH_TOKEN` reveals nothing, which is why the tool can safely be a full shell. Needs e2b ≥2.31 for `SandboxNetworkOpts.rules`.
- **`wait`** (core): a bounded, abort-aware mid-turn pause — up to **1 hour** per call. It calls `extendAttemptDeadline` (threaded from `agent/index.ts` through `buildTools`) so the attempt watchdog treats a long deliberate pause as work, not a stall. `pauseSandbox: true` suspends the sandbox for the duration (`session.destroy()` pauses a persistent sandbox; the next sandbox command auto-resumes it) — ignored under 120s, and it suspends any background process too.
- **`writeFile`** takes `append`. A tool call's arguments ride inside the model's own token budget, so one call cannot carry a very large file — the description tells the model to chunk a big write (first call `append:false`, rest `append:true`). See the truncation note under Models.
- **`fetchUrl` rejects Slack links** (`isSlackLink`): a `*.slack.com` URL 302s to a login wall, so the tool refuses and points the model at the Slack read tools (readConversationHistory for a message — path `/archives/<CHANNEL>/p<TS>`; getFile for a file).
- **Email** (`tools/email.ts`) runs **host-side** via the AgentMail SDK using `AGENTMAIL_API_KEY`; registered only when that key is set. Not in the sandbox.
- **Image generation** (`tools/generate-image.ts`) calls HackClub's `/images/generations` directly (model `google/gemini-3.1-flash-image`), parsing `data[].b64_json`. The AI SDK `generateImage` path never reached the endpoint — don't go back to it.
- **Web search** (`searchWeb`) uses Exa via `EXA_API_KEY`. The placeholder key (`exa-placeholder-no-websearch`) makes every search return `ExaError: Invalid API key`.

### Browser

`browser` (`tools/browser.ts`, deferred) runs the preinstalled `agent-browser` CLI **inside the sandbox**. Pass CLI args in `command` (run `skills get core` first).

It drives **CloakBrowser**, not agent-browser's own Chrome (`lib/browser/cloak.ts`, `ensureCloakBrowser`). CloakBrowser is a Chromium with ~66 source-level C++ fingerprint patches (canvas, WebGL, audio, fonts, GPU, WebRTC, automation signals), so anti-bot systems score it as ordinary and **most sites never serve a challenge at all**. It does NOT solve captchas — it prevents them. Every `browser` call first runs an idempotent ensure script: exit if CDP on :9222 answers, else install `cloakbrowser`, launch it **headful under Xvfb** (headless still gets flagged; falls back to `--headless=new` if Xvfb won't install) with `--fingerprint-platform=windows`, then `agent-browser connect 9222`. A sandbox pause kills the Chromium process but keeps the cached binary, so a resumed thread relaunches in seconds. `cloakbrowser` + `xvfb` are baked into the E2B template.

If a captcha DOES appear, the tool description and core prompt tell the model to snapshot the page and **click the checkbox like a person would** — never to claim it can't get past one before trying.

**Scripting it directly**: the sandbox prompt tells the model `cloakbrowser` is a real npm package (a stealth Chromium, drop-in Playwright/Puppeteer replacement — the same browser the tool drives), so for a loop or a scheduled job it should write a Node script against it instead of one `browser` call per action. The **headful rule** applies there too: a scripted job must run under `xvfb-run -a node script.js` with `fingerprintPlatform: 'windows'`, or it gets flagged — which is why a hand-written script "can't" clear a captcha the `browser` tool clears.

### Subagent

`tools/subagent.ts` — a headless copy of kyto: **shares the parent turn's sandbox** (`getSandboxContext` threaded in from `toolset.ts`, so it works in the same filesystem the parent set up and leaves its output there), the full toolset, driven by the same `streamAttempt` loop, returning its final text as a report. Deferred; registered only when a subagent model exists.

- **Nesting is ONE level** (`MAX_SUBAGENT_DEPTH = 1`): a subagent may not spawn another. A second level is cost/time risk for no real use.
- **It must NOT create or destroy the sandbox** — the parent owns the lifecycle and pauses it at turn end. The subagent's `finally` only closes per-turn tool/MCP connections.
- **Model roster + report fallback** (`subagentAttempts`, `providers/attempts.ts`): cheap Gemini `gemini-3.1-flash-lite` first, then the DigitalOcean BYOK models. The subagent **walks this list** when an attempt throws OR comes back with an empty report — pinning one cheap model meant a whole "herd" of subagents frequently reported nothing back. If a model ran tools but wrote no prose, `synthesizeReport` re-asks THAT model once with **tools off** to write up what it found, so the parent gets findings instead of "(Completed actions…)".
- **How the report reaches the parent**: the foreground path returns `{report, success:true}` as the tool call's RESULT; the AI SDK feeds it back as a `tool` message and the parent answers from it on its next step.
- **Background + `checkSubagent`** (`background: true`): registers the job in an **in-turn registry** (ids `sub-1`, `sub-2`…) and returns the id immediately. The parent keeps working, then calls **`checkSubagent`**: no id → lists every background subagent and its status; with an `id` → status and, once finished, the full report; `wait: true` blocks until it finishes. Tied to the parent turn's abort signal. The registry is per-turn, so background+collect works WITHIN a turn (same as bash background processes).
- **It posts its OWN streamed message** — a second `slack.stream`, authored "kyto subagent" (+ optional `name`) with that identity's icon. It renders exactly like a real turn (shared `renderStream`: interleaved Thinking/tool cards in stream order), with a **Prompt** card (full task), a **Model** card per attempt, and a **Response** card holding its full final reply. **Everything lives inside the one collapsible plan; nothing in the message body** — the response is captured via `onTextDelta` (no `emitText`).
- It runs on a slimmer system prompt (`subagentSystemPrompt`): a lean `<subagent>` core + sandbox + context, without personality/tone, the custom-instruction hierarchy, broadcast etiquette, or the media/copyright framing. Keeps finish-the-job, parallel-tool, loadTools, private-auth, SFW, and report-back guidance.

### Recurring reminders

`tools/reminders.ts`, `lib/reminders/scheduler.ts`, `@repo/db` `reminders`. Unlike the one-time `scheduleReminder` (Slack's native `chat.scheduleMessage`), recurring reminders are driven entirely by kyto's own always-on process — Slack has no recurring-schedule API.

A row holds `user_id`, `text`, `recurrence` (`interval`|`daily`|`weekly`) plus the relevant `interval_seconds`/`time_of_day_minutes`/`weekday`, `next_run_at`, `channel_id` (fire into a channel vs DM — **owner-only**, same admin gate as cross-channel posting), `max_runs`/`run_count`, `thread_id`, `kind`, `editor_user_ids`. `startReminderScheduler` polls every 30s and posts each due reminder, then advances `next_run_at`. Posts honor the reminder identity profile; a channel-targeted reminder prefixes the text with `<@user>`.

**Kinds** (`reminders.kind`), with their interval floors:
- `message` (default, 60s): posts `text` verbatim.
- `script` (60s): fetches `url` each fire and posts its content (`fetchUrlText`, shared with `fetchUrl`).
- `bash` (5 min — a sandbox resume; `lib/reminders/bash.ts`): runs `command`, posts its exact stdout/stderr, **in the persistent sandbox of the thread it was created in** — so it can run a script kyto wrote earlier. A row without `thread_id` falls back to `runOnce` (throwaway sandbox, empty every fire).
- `agent` (1 hour — a real model run; `lib/reminders/agent.ts`): runs a **headless kyto** (same `streamAttempt` loop, full toolset, nothing streamed) with `text` as instructions and posts its final reply. Pinned to the cheap subagent model so an unattended job's cost is predictable. Reuses the thread's sandbox. `searchSlack` does NOT work here (its action token needs a live user interaction) — the system note says so.

Tools: `scheduleRecurringReminder`, `listReminders`, `pauseReminder`, `resumeReminder`, `cancelReminder`, `editReminder` (changes text/kind/command/url/schedule/maxRuns/editors in place; only the fields passed are touched; a new schedule takes effect from now and a bare `intervalSeconds` is re-floored against the kind). An **App Home "Reminders"** section lists each reminder a user may act on with Pause/Resume/Delete buttons.

The scheduler fires due reminders **concurrently** (a slow `bash`/`agent` fire must not delay everyone else) and guards **overlapping fires** with an in-flight `Set` — a row is only advanced *after* it fires, so a multi-minute run would otherwise restart on every 30s poll. `advanceReminder` computes the next run from `max(nextRunAt, now)`, so a schedule left in the past (scheduler downtime) doesn't re-fire on every poll until it catches up.

### Slack search

`assistant.search.context` runs with the **requesting user's** own Slack access, so it reaches private channels and DMs that user is in — but only with the granular scopes granted (`search:read.public`/`.files`/`.users`/`.private`/`.im`/`.mpim`; the last three were missing once and silently limited every search to public channels).

- **Cost**: it returns `limit: 10` matches with `include_context_messages: true` (~5 before/after each). Those context messages are the dominant input-token driver — they ride along in every subsequent step, ballooning a turn to 100k–270k input tokens. We trim each match to the **2 nearest before + 2 after**. Drop `limit` or trim bodies further if cost climbs again.
- **Modifiers**: the `query` supports Slack's full search-bar set, combinable — `from:`, `to:`, `in:` (`#channel` or `@user` for a DM), `on:`/`before:`/`after:`/`during:`, `has:link`/`star`/`pin`/`:emoji:`, `is:thread`/`dm`/`external`, `filename:`, `ext:`. In the tool description and core prompt, so the model narrows queries instead of filtering broad results itself.
- **Action-token urgency**: the `action_token` expires ~2 min after the turn starts, so the core prompt tells the model to run all `searchSlack` calls early — a search late in a long turn can fail purely from token expiry.

### Slack read-only scripting (host-side proxy)

`slackScript` (deferred, gated on `SITES_ENABLED`) runs a bash script for **aggregate** Slack questions ("who is in the most channels") in one script instead of N tool round-trips. It POSTs to a **host-side, secret-gated, READ-ONLY proxy** on the sites server at `/_slackapi/<method>` (`lib/slack-proxy/`). The **bot token never enters the sandbox**: the proxy attaches the real token and forwards ONLY the `READ_ONLY_METHODS` allowlist (users.*, conversations.*, team.*, usergroups.*, reactions/pins/bookmarks list, emoji.list) — posting/editing/deleting is impossible through it. (Our bot token is not itself read-only, which is why it can't just be handed to the sandbox.)

**`slack` is a real executable on PATH**, not a shell function prepended to the tool's script: `slackHelperInstall()` is `LazySandbox`'s `bootstrapCommand`, run each time a sandbox materializes (create AND resume — so it must stay idempotent). So the plain `bash` tool and a `bash` reminder can query Slack read-only too. The helper reads `KYTO_SLACK_PROXY[_TOKEN]` **from the environment at call time** and `run()` re-sends env on every command — that's what lets a *persistent* sandbox outlive any single turn's token, and why a **`bash`/`agent` reminder mints a fresh proxy token at fire time and revokes it after** (without that, a scheduled script could only ever 401). With no proxy env the helper fails loudly rather than silently doing nothing.

There is **no search method in the allowlist**, so "count a user's messages" means paging `conversations.history` per channel — slow, not a bug. Add `search.messages` (needs `search:read`) if that's ever wanted. NOTE: the subagent's sandbox does not get the proxy env, so `slackScript` inside a subagent 401s.

### Focus mode

`focusMode` (core) locks kyto onto specific user ids in the current thread: it only replies to those users AND their messages are the only ones it **sees** — non-focused messages are filtered out of the prompt (`isFocusAllowed`, `lib/agent/focus.ts`), not just ignored, so others can't hijack it in a public thread. The **owner is always allowed through** and kyto's own messages always stay in context. Gated in `bot.ts`; persisted on `thread_subscriptions.focus_user_ids`. Call with `clear: true` to turn it off.

### Canvases and pins

- `canvasList` takes an optional `channelId`; on `not_in_channel` it joins the public channel **silently** and retries.
- `canvasWrite` create modes accept `title`. `create-channel` best-effort **adds the canvas as a channel tab** by bookmarking its permalink (`addCanvasTab`), since `conversations.canvases.create` alone doesn't always surface a header tab. Needs `bookmarks:write` + `files:read`.
- `pinMessage`/`unpinMessage` take an optional `channelId` and `as: 'bot' | 'user'`. As the bot, `not_in_channel` triggers one `conversations.join` + retry. `as: 'user'` pins as the owner via `SLACK_USER_TOKEN` and is owner-gated. Needs bot `pins:write` and, for `as:'user'`, the user-scope `pins:write`.

### Static site hosting

`deploySite`/`removeSite`/`listSites` publish static sites at `https://<host>/<name>/` (default host `kyto.devansh.hackclub.app`). Code in `lib/sites/`. The host **never executes site code** — building/testing happen in the E2B sandbox; only static output is copied out (`resolveWithin` path containment).

Both tools take an optional `page` sub-path (`docs/intro`), served at `/<name>/<page>/`, validated by `isValidPagePath`. A page deploy atomically swaps only that sub-path; omit `page` for the whole site.

The server starts from `apps/bot/src/index.ts` (`startSitesServer`) and serves **plain HTTP** by default because it sits behind Nest's TLS-terminating proxy (serving HTTPS there → 502); `SITES_TLS=true` for a self-signed cert standalone. Config: `SITES_ENABLED`, `SITES_PORT` (8080), `SITES_TLS`, `SITES_ROOT` (`/var/kytosites`), `SITES_PUBLIC_HOST`.

## Ownership & edit permission (reminders + sites)

Things kyto creates on someone's behalf and can later change carry an access list, so a bystander in a public thread can't rewrite someone's reminder or take down their site. The rule, shared by both: **the creator, anyone the creator named as an editor, and the bot owner.** The core prompt tells the model the rule, and that a refusal is not something to work around — just say who owns the thing.

- Set at creation via an optional **`editors`** param on `scheduleRecurringReminder` and `deploySite` (user ids or `<@U123>` mentions; `parseEditors` in `tools/editors.ts` rejects anything that isn't a user id, so a display name can't become a permission entry that never matches). Omitted = creator only.
- Enforced **at execute time against `message.author.userId`** — the person actually talking to kyto this turn, not whoever the model claims to act for. Reminders: `isReminderEditableBy` plus `editableBy` (a jsonb `@>` containment check) scoping every list/pause/resume/cancel/edit query. Sites: `checkSiteAccess` + `canEdit`.
- Storage: `reminders.editor_user_ids` (jsonb) and the `sites` table (`name` PK, `owner_user_id`, `editor_user_ids`). The first deploy of a name **claims** it. A whole-site `removeSite` releases the name; removing one `page` does not. Sites published before the table existed have no row — `siteExistsOnDisk` makes them bot-owner-only rather than free for the next person to claim.

## Identity, gating, and etiquette

- **Broadcast mentions are owner-gated.** Only the owner may make kyto ping a whole channel. `neutralizeBroadcast` (`harness/markdown.ts`) downgrades `<!channel>`/`<!here>`/`<!everyone>`/`<!subteam^…>` to inert plaintext, applied to the streamed reply (`createReply({allowBroadcast})`, `allowBroadcast = isOwner`) and the `postMessage` tool's non-owner path.
- **Broadcast rendering**: Slack's `markdown` block does NOT resolve control mentions — they come out as plaintext. So `ThreadHandle.post` detects a control-mention token (`CONTROL_MENTION`) and posts that message as a `section`+`mrkdwn` block instead (losing GFM niceties for that message only). The core prompt tells the model to ping with `<@id>` and broadcast with the raw `<!channel>` tokens.
- **Cross-channel posting is owner-gated** (`tools/post-message.ts`): a non-owner may only post back into the same channel kyto was mentioned in. This is the admin requirement that a thread in #general can't be used to post into #announcements. **Send/edit-as-owner** (`sendAsUser`/`editAsUser`, via `SLACK_USER_TOKEN`) is only **registered** when the author is the owner, and each re-checks at execute time.
- **Opt-in gating** (`OPT_IN_CHANNEL`): an un-opted-in user who @s kyto gets `offerOptIn` (`lib/onboarding.ts`) — a visible in-thread reply with an "i accept" button. Membership of `OPT_IN_CHANNEL` is the allowlist (`lib/allowed-users.ts`).
- **`##` messages are invisible to kyto.** A message with any line beginning `##` (after stripping leading mentions) is a human-only side-channel: `isHiddenFromBot` makes `shouldIgnore` skip it AND `buildPrompt` filter it out of replayed history — so kyto never triggers on it and never sees it.
- **No channel-join greeting, ever.** The `member_joined_channel` handler posts **nothing**. Ban history: kyto once auto-joined a post-restricted channel to search it, and its greeting posted where normal members can't — it got banned. Do NOT re-add any `member_joined_channel` post. General rule: **kyto only ever speaks in reply to being invoked, never unsolicited.**
- **The bot's Slack username is a gorkie-era handle** (`gorkie__devansh_`, immutable) but its **display name is `kyto`**, so `@kyto` resolves to this bot (`U0BD3555UCQ`, app `A0BCA6D6GAV`). `auth.test`'s `user` field returns the username, not the display name — don't conclude `@kyto` is a different app. `annotateMentions` special-cases the bot's own id and annotates it as `kyto`, so the agent never mistakes its own mention for gorkie.
- **Kyto is closed-source.** `prompts/slack.ts` says plainly that kyto's code is private with no public repo link to share. It began as a private fork of the open-source gorkie, but that's as far as the public trail goes — do NOT point users at `imdevarsh/gorkie-slack` as "kyto's source".
- **Owner grounding**: without it, asked "who coded you", kyto confabulated ("a team of engineers at a private organization") and disputed the truth when the real owner corrected it. `RequestHints.ownerUserId` (from `OWNER_USER_ID`) is rendered into the context block as a plain statement of who owns/built kyto, with an instruction not to hedge or invent a different origin.

### Identity profiles

`identity_profiles` table (`message_type` PK ∈ `normal`|`subagent`|`reminder`, `name_suffix`, `icon`). Owner-configured from an **App Home "Identity"** section. The base name is ALWAYS "kyto" (a suffix is appended, e.g. "kyto subagent"); it can never be renamed. `resolveIdentity(type)` (`lib/identity.ts`, 30s cache) returns `{username?, iconEmoji?, iconUrl?}` — `icon` is a `:emoji:` code or an image URL (a unicode emoji can't be an `icon_emoji`). Applied to reminder posts, cross-channel `postMessage`, and the subagent's own streamed message. Needs `chat:write.customize`.

## Response style and the plan UI

- `prompts/personality.ts`: write like a human in Slack — natural sentence case, no Title Case, no ALL CAPS for emphasis, no over-punctuation; casual lowercase is fine, match the other person's register.
- **kyto MAY narrate.** The old "don't narrate every step" block was removed (owner's call) — in-between status updates are wanted, and the plan splits to match.
- **Multi-block turns — `streamSegmented`** (`agent/index.ts`): a turn is a SEQUENCE of streamed plan messages, not one. `renderStream` takes `emitText: true` (yields reply text as plain strings alongside task chunks, in stream order); `streamSegmented` cuts a new plan message whenever a task card arrives AFTER reply text has streamed in the current block. So `[plan] text [plan] text` — the model can post an update and keep working in a fresh collapsible block instead of every tool piling into one plan pinned above all the text. Text itself is posted by `createReply` (`agent/reply.ts` — length-splitting, fence/table healing); `streamSegmented` only controls WHEN each plan opens/closes around it.
  - **Only VISIBLE text splits a block** (`isVisibleText` — non-whitespace). Models routinely emit whitespace-only fragments (`"\n"`) between tool calls; `createReply` never posts those, so splitting on them opened an empty collapsible block for every stretch of tools — the "three plan blocks, no text in between" bug.
  - The attempt's **Thinking (model) card is completed at first visible reply text**, so it finishes inside its own block rather than a later one where its task id doesn't exist (which would leave a perpetually spinning Thinking).
- **Reasoning** renders under the title `Thinking`, and **each reasoning block gets a UNIQUE task id**: providers reuse the same `part.id` (often `"0"`) for every step's reasoning, so keying the task on it collapsed ALL thinking into one row pinned wherever it first appeared. `renderStream` mints `reasoning-${counter++}` per `reasoning-start`, so the plan reads thinking → tool → thinking → tool.
- **Hallucinated tool calls are hidden.** Weak models sometimes call a tool we never registered; the harness returns "Tool X not found" and the model recovers next step. `renderStream` is passed `knownTools` and drops any such tool-call (and its matching result/error).
- **Usage footer** (`postUsageFooter`): a muted context block under the reply showing `<output tokens> · <N> tok/s`. Per-user opt-out via `user_customizations.show_usage_footer`, toggled from an App Home button. The resolved model is shown in the `Thinking` task, not here.

## Models / fallback

**Full detail lives in [`.claude/MODELS.md`](./MODELS.md) — read it before touching routing, and update it when you change routing.** The essentials:

- **Primary is pinned `z-ai/glm-5.2`** (`ROUTER_MODEL`, `packages/ai/src/providers/attempts.ts`) via HackClub — cheap enough to stretch the daily $3 cap.
- **An ATTEMPT is "handled" iff IT produced reply text or a deliberate `skip`** (per-attempt, not per-turn — a continuation attempt inherits the turn's text and would otherwise report success having said nothing). Anything else falls back down `LEADERBOARD_FALLBACK`, then the DigitalOcean BYOK tier (a separate quota), then the owner's Gemini key. A model that ran tools but wrote nothing gets ONE `synthesizeFinalAnswer` nudge (same model, `tools: {}`) before that.
- **A provider that dies MID-STREAM does not throw** — the AI SDK turns a failed step into an `error` part and just ends the stream. That was the real "kyto stops in the middle": text had already streamed, so the turn looked handled and it went quiet mid-task while the journal said `turn complete`. Now an error part + a last finish reason that isn't `stop` raises `StreamInterruptedError`, the ONE case where a turn that already streamed text may still fall back. The next model gets `renderContinuation` (the tail of what the user was already shown) plus `renderCarryover`, so it finishes the job instead of restating it.
- **A tool call truncated mid-JSON is repaired, not fatal** (`repairTruncatedToolCall`) — a huge `writeFile`/`postMessage` argument can hit `MAX_OUTPUT_TOKENS` mid-string.
- **HackClub's budget/outage failures short-circuit the rest of HackClub** (shared proxy, shared budget) and jump straight to DigitalOcean.
- **Prompt caching** (1h TTL) and **`maxOutputTokens: 8000`** are applied on the metered proxies; the latter is what defuses HackClub's pessimistic spend projection.
- **Gemini requires `thought_signature` replay** or every multi-step tool turn 400s.
- **Per-attempt watchdog** (10m, `AGENT_ATTEMPT_TIMEOUT_MS`), re-armable — the `wait` tool extends it so a long deliberate pause isn't read as a stall.

### Turn logging (diagnose a bad turn from the journal alone)

Every failure mode above should be readable from `journalctl -u kyto.service` without a Slack transcript. The lifecycle lines, in order: `[agent] turn started` (user, thread, attachments) → `[agent] routed turn` → `[agent] attempt started` (model, index, whether it's continuing an interrupted turn) → `[stream] provider error mid-stream` (status + upstream body, on an error part) → `[stream] attempt stream ended` (the `StreamTally`: textChars, toolCalls, finishReasons, errors) → `[agent] attempt handled the turn` / `[agent] attempt failed, falling back` (status + `errorDetail`) → `[agent] turn complete` / `[agent] turn failed` (durationMs, `failedAttempts` = the whole fallback walk with each model's status and error).

`streamAttempt` takes an `onError` — without it the SDK's default handler `console.error`s a raw unattributed stack blob, which is what made the mid-stream 429 impossible to pin to a turn. Never remove it. `errorStatus()` digs the HTTP status out of the `AI_RetryError` → `APICallError` chain (it's never on the outer error), and `deepErrorText()` gets the upstream body.

## Sandbox / E2B — lazy, and persistent per thread

Config in `packages/sandbox/src/config.ts`. E2B is the execution backend for the `bash`/file tools and the host tools that opt into it (`browser`, `deploySite`, `getFile`, `uploadFile`).

- **Lazy** (`LazySandbox`): the real `Sandbox.create` is deferred until a tool touches it, so chat-only turns cost zero E2B.
- **Persistent per thread**: `destroy()` **pauses** rather than kills, and the thread's `sandbox_id` is remembered in `thread_sandboxes`; the next turn calls `Sandbox.connect(id)` (which auto-resumes) and gets the same filesystem back — files, installed packages, downloaded data (~450ms resume). This is what makes a **`bash` recurring reminder** useful: kyto writes and tests a script in the thread, then schedules the reminder to run it. `prompts/sandbox.ts` tells the model so. It's also what the `wait` tool's `pauseSandbox` leans on.
  - Persistence is opt-in via the injected **`SandboxStore`** (`load`/`save`/`clear`) — `packages/sandbox` stays free of a DB dependency. The bot's impl is `lib/sandbox/store.ts` (`threadSandboxStore`). A `LazySandbox` built WITHOUT a store is ephemeral.
  - **A thread, not a "conversation."** Every message roots its own thread (including a top-level DM), so a new top-level DM gets a **new** sandbox.
  - **Two things are fixed at CREATE time and therefore stale on a resumed sandbox**: the `network` egress rules (which broker `GH_TOKEN`) and the create-time `envs`. Rotating `GH_TOKEN` only takes effect on a thread's next fresh sandbox. Per-command env IS re-sent on every `run()`, so the short-lived Slack proxy token stays current.
  - **A thread's sandbox is one mutable machine**, and both a live turn and a `bash`/`agent` reminder reach for it. `acquireThreadSandbox`/`withThreadSandbox` serialize them, so a reminder can't pause the sandbox out from under a running command. A turn holds the lock for its whole duration.
  - **A paused sandbox costs storage**, so `startSandboxReaper()` (hourly) kills anything untouched for **7 days** (`SANDBOX_TTL_MS`). `runOnce()` spins up a throwaway sandbox for callers with no thread to reuse.
- **Memory = the Slack thread.** `buildPrompt` feeds the whole thread (`slack.fetchMessages`, capped) as context; no model session is persisted. Message contents are never stored, so kyto remains "live processing without storing message contents" for the Slack Scraping policy — the sandbox persists a *filesystem*, not a transcript. `langfuse` tracing stays disabled for the same reason.

## Manifest sync

`bun run sync:manifest` (apps/bot) pushes `slack-manifest.json` via `apps.manifest.update`. Needs a Slack **app configuration token** (not the bot/user token): `SLACK_APP_ID`, `SLACK_CONFIG_ACCESS_TOKEN`, optional `SLACK_CONFIG_REFRESH_TOKEN` (auto-rotates the short-lived access token first). Scope changes require reinstalling the app. Slack scopes are declared in `slack-manifest.json` — update it when a tool needs a new one.

## Debugging "kyto isn't responding"

- It runs under **systemd** (`kyto.service`, unit at `deploy/kyto.service`, `Restart=always`, on boot). `journalctl -u kyto.service -f -o cat`. Two unrelated Slack apps also run on this host (`slackbot.service`, `hackclub-ai-status-bot.service`) — different tokens, no interference.
- **Never hand-launch a second copy.** Each process opens its own Socket Mode connection and Slack delivers each event to only ONE, so a stray manual instance silently steals ~half the mentions. Diagnose with the `hello` frame's `num_connections` (open a throwaway socket via `apps.connections.open`) — it should be **1**.
- **Slash commands work but @mentions/DMs don't = Event Subscriptions are off.** Socket Mode routes slash commands, interactivity, and events independently; if the **Enable Events** master toggle is off (it silently turned off once), `slash_commands` still deliver while `app_mention`/`message.*` deliver nothing. Re-enable it in the app config.
- **Zombie socket**: a dropped WSS can stay TCP-`ESTAB` with a stuck send-queue (`ss -tnp | grep :443` shows non-zero Send-Q) while delivering nothing. Restarting re-establishes it.

## Branches

**`main` is the branch actually deployed** (`kyto.service`'s working directory tracks what's checked out here). `rebuild-on-upstream` is an old Pi-era branch; **`main` is a strict superset of it** (audited 2026-07-09) — anything that looks "new" over there is *older* Pi/chat-sdk infrastructure. Nothing to harvest. Its `MAX_RECURRING_RUNS = 20` global auto-cancel was deliberately NOT ported (it would silently kill existing "forever" reminders).

## Database notes

New tables/columns are pushed with one-off SQL scripts — `drizzle-kit push` prompts interactively (a rename decision against pre-existing tables) and hangs in a non-TTY shell. Use `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`. `db:generate`/`db:push` work normally for a human running the CLI. NOTE: `authorization` is a reserved word — quote it in DDL. The `sandbox_sessions` table is **orphaned scaffolding** from an abandoned persistence attempt; `thread_sandboxes` is the live one.
