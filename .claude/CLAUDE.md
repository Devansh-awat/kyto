# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bun x ultracite fix` before committing to ensure compliance.

---

## Project Notes (Kyto Slack bot)

> **Keep this section current.** Whenever you add, remove, or change a feature
> (a new agent tool, a changed scope, a config flag, gating rules, etc.), update
> the relevant note below in the same change — do this proactively, without
> asking for permission. Treat these notes as living documentation — stale notes
> are worse than none.

### After every change (auto workflow — this is a private repo)
Run these automatically after each completed change, in order, **without asking**:
1. **Auto-commit.** Commit the change locally with a clear conventional-commit
   message, keeping these doc notes updated in the same commit. One logical
   change = one commit.
2. **Sync the Slack manifest if it changed.** If the change touched
   `slack-manifest.json` (new tool/scope, command, display text, etc.), run
   `bun run sync:manifest` from `apps/bot` to push it to the Slack app config.
   (Needs the app config token env vars — see the Manifest sync note. Scope
   changes still require reinstalling the app.)
3. **Restart the bot** so the running process picks up the change. The bot runs
   under **systemd** as `kyto.service` (unit tracked in-repo at
   `deploy/kyto.service`; `WorkingDirectory=/root/kyto/apps/bot`,
   `ExecStart=/root/.bun/bin/bun run src/index.ts`, `Restart=always`, enabled on
   boot). Restart with `systemctl restart kyto.service`; check it with
   `systemctl status kyto.service` and `journalctl -u kyto.service -n 30 -o cat`
   (look for `kyto (…) is online`). Do NOT hand-launch `bun run start:bot` — a
   manual process becomes a **second Socket Mode connection** that competes with
   the service for events (Slack delivers each event to only ONE connection). If
   the unit file itself changed, `sudo systemctl daemon-reload` first.
4. **Push to the private repo** (`origin` →
   `github.com/Devansh-awat/kyto.git`). After committing, `git push origin` the
   current branch automatically, **without asking**. This is the owner's private
   repo, so pushing is pre-authorized.

- **NEVER push to `upstream`** (`github.com/imdevarsh/gorkie-slack.git`, the
  fork source). Auto-push is `origin` only.
- **Opening a PR still asks first.** Auto-commit/restart/sync/push-to-origin are
  pre-authorized; `gh pr create` (or any cross-repo publish) requires explicit
  user confirmation.

### Architecture — fully custom harness (July 2026 rewrite)
- **The Vercel Chat SDK (`chat`/`@chat-adapter/slack`/`state-pg`), the Pi agent
  framework, and `@ai-sdk/harness*` were completely removed** in a ground-up
  rewrite. Kyto now runs on:
  - **Custom Slack harness** (`apps/bot/src/harness/`): `@slack/socket-mode` +
    `@slack/web-api` directly. `SlackHarness` (`harness.ts`) is the Web API
    facade (thread-id codec `slack:CHANNEL[:TS]`, message building,
    fetch/history/listThreads, reactions, assistant status/prompts, native
    streaming via `webClient.chatStream` — task cards use the same
    `task_update` chunk shape as before, `task_display_mode: 'plan'`).
    `KytoBot` (`bot.ts`) owns the Socket Mode connection and event routing
    (`onNewMention`/`onDirectMessage`/`onSubscribedMessage`/`onAction`/
    `onModalSubmit`/`onAppHomeOpened`/assistant events/`onMemberJoinedChannel`
    — same handler names as the old chat-sdk, so call-sites barely changed).
    `ThreadHandle` (`thread.ts`) is the thread surface: `post` (Block Kit
    native `markdown` blocks; files via `filesUploadV2`; **per-message profile
    overrides** via `username`/`iconUrl`/`iconEmoji` — needs the
    `chat:write.customize` scope, added to the manifest), `postEphemeral`,
    `schedule`, `subscribe`/`setState` (thread subscriptions now live in our
    own `thread_subscriptions` Postgres table + 30s in-memory cache — the
    chat-sdk state-pg tables are orphaned), `fetchMetadata`. `app_mention`
    events are deliberately ignored — everything routes off `message` events
    (mention = text contains the bot id), which is what kills the old
    dupe/dedupe problem. Slash command `/kyto` is acked with a help line in
    the router. Every message threads (top-level DM/channel message roots its
    own thread) — the old DM-threading `bun patch` is gone with the adapter.
  - **Custom agent loop** on `ai` `streamText` (`packages/ai/src/agent.ts`
    `streamAttempt` + `apps/bot/src/lib/agent/index.ts`): multi-step tool loop
    (`stopWhen: stepCountIs(60)`), per-attempt `@ai-sdk/openai-compatible`
    provider. The old **global fetch interceptor is gone** — a per-provider
    `fetch` in `streamAttempt` injects the `auto-router` plugin
    (`ALLOWED_MODELS`/`COST_QUALITY_TRADEOFF`, now in
    `packages/ai/src/providers/attempts.ts`), adds `reasoning: {effort:
    'medium'}` on HackClub, and captures the resolved model into a per-attempt
    `ResolvedModelHolder` (no AsyncLocalStorage). `max_tokens` capping is now
    just `maxOutputTokens: MAX_OUTPUT_TOKENS` (8000) on HackClub attempts.
    The fallback state machine (auto → pinned resolved retry → leaderboard
    up/down walk, spend-limit-429 → straight to Gemini, carryover of gathered
    tool results, per-attempt watchdog, clean-stop handled check) ported
    unchanged. `renderStream` consumes `result.fullStream` (same
    `TextStreamPart` shapes). System prompt goes directly to `streamText` —
    the SYSTEM.md tmp-file hack died with Pi. Old `attempts.ts` → `attempts.ts`
    (`PiAttempt` → `ModelAttempt {provider, model, baseURL, apiKey}`); the
    dead catalog/attemptsFor/deepFallback exports were deleted.
  - **Sandbox tools are ours** (`apps/bot/src/lib/ai/tools/sandbox.ts`):
    `bash`, `readFile`, `writeFile`, `editFile` run against `LazySandbox`
    (`packages/sandbox/src/lazy-sandbox.ts`) — E2B `Sandbox.create` happens on
    the FIRST tool call that needs it (chat-only turns cost zero E2B), killed
    at turn end. The old harness-bootstrap command-faking (`lazy-session.ts`)
    is gone — nothing to fake when we own the loop. Pi skills are gone too.
  - **Deferred tools**: uncommon tools (browser, email trio, canvasDelete,
    createChannel, setChannelTopic, bookmarkLink, pins, poll, mermaid,
    sendAsUser/editAsUser, and all MCP tools) are registered but hidden from
    the model until it calls the **`loadTools`** meta-tool (whose description
    lists them). Visibility is enforced per step via `streamText`'s
    `prepareStep`/`activeTools` (`buildTools` returns `{tools, activeTools,
    close}` — `close` tears down per-turn MCP connections).
  - **Per-user MCP servers** (`apps/bot/src/lib/ai/mcp.ts`, `user_mcp_servers`
    table): users add remote Streamable-HTTP MCP servers from kyto's **App
    Home tab** (Add/Remove UI in `features/customizations`, modal callback
    `home_add_mcp_server`; optional Authorization header stored as-is). A
    hand-rolled ~200-line JSON-RPC client (initialize / tools/list /
    tools/call; SSE-response parsing; NO legacy SSE-only transport) connects
    lazily per turn; tool listings are cached 10 min per URL; tools are
    namespaced `mcp_<server>_<tool>` and deferred behind `loadTools`. A dead
    server degrades that turn's toolset only. Local (user-machine) MCP servers
    are impossible over Slack by design.
  - **Chat-sdk state replacement**: `bot.getState()` is now an in-memory TTL
    KV (`harness/kv.ts`) — fine because everything stored there (allowlist,
    name caches) is rebuilt at startup or on demand. Markdown conversion is
    ours (`harness/markdown.ts`): inbound mrkdwn→markdown for prompts,
    `healMarkdown` closes dangling fences/markers in chunked replies
    (replaces StreamingMarkdownRenderer). Modals/App Home go through
    `webClient.views.*` directly.
- **Env**: `SLACK_APP_TOKEN` is now required (socket mode is the only mode).
- New tables were pushed with a one-off SQL script (drizzle-kit push is
  interactive in non-TTY): `thread_subscriptions`, `user_mcp_servers` (NOTE:
  `authorization` is a reserved word — quoted in DDL).

### AI tools
- Agent tools live in `apps/bot/src/lib/ai/tools/` and are registered in
  `apps/bot/src/lib/ai/toolset.ts`. Raw Slack Web API access is via
  `slack.webClient.apiCall(method, args)` from `@/lib/chat`; error helpers are
  `errorMessage()`/`toLogError()` from `@/lib/utils/error`.
- Fork-added tools: `canvasRead/Write/List/Delete`, `pinMessage`, `unpinMessage`,
  `bookmarkLink`, `createChannel`, `setChannelTopic`, `poll`, `getPermalink`,
  `fetchUrl`, `deploySite`, `removeSite`, `skip`, `sendAsUser`, `editAsUser`,
  `browser`, `sendEmail`/`checkInbox`/`replyEmail`, `joinThread`,
  `scheduleRecurringReminder`/`listReminders`/`cancelReminder`.
- **Ported from `rebuild-on-upstream`** (the owner's own Pi-era branch,
  reimplemented on the custom harness — see the July rewrite note): `gh`
  (GitHub CLI in the turn's sandbox — the real GitHub token is **brokered via
  E2B egress rules** so it is **never in the sandbox at all**: `LazySandbox`
  (`packages/sandbox`) sets `network.rules` that inject the `Authorization`
  header on outbound requests to `api.github.com`/`uploads.github.com` (Bearer)
  and `github.com` (Basic) at the proxy layer, and the sandbox env holds only an
  inert base64 placeholder. So `gh`/`git` are pre-authenticated inside the
  sandbox but `echo $GH_TOKEN` reveals only the placeholder — the char-at-a-time
  drip attack is fully moot, so the tool is back to a **full shell** (piping,
  jq). This is exactly gorkie's technique; it needed the **e2b 2.21→2.31**
  upgrade (`@e2b/code-interpreter` 2.4→2.6) for `SandboxNetworkOpts.rules`
  (`allowOut` must include the exported `ALL_TRAFFIC` sentinel when set).
  Deferred, needs `GH_TOKEN` on the host; brokering activates automatically for
  every sandbox when `GH_TOKEN` is set. More robust than the external AGPL
  `techwithanirudh/gorkie`, which ships a doc-only gh-cli Pi skill),
  `runBackgroundProcess`/`getProcessOutput`/`killProcess` (nohup-based detached
  processes tracked in-turn — deferred), `wait` (bounded, abort-aware mid-turn
  pause — core), `deleteFile`/`fileStat` (workspace file ops — core),
  `textToSpeech` (Replicate via HackClub's proxy `HACKCLUB_REPLICATE_API_KEY`,
  else Gemini TTS; uploads audio to the thread — deferred), `unreact` (removes a
  reaction; added `SlackHarness.removeReaction`), and `runSubagent` (see below).
- **Subagent** (`tools/subagent.ts`): a headless copy of kyto — its own fresh
  `LazySandbox`, the full toolset (can delegate further, depth-capped at 2 via
  `AsyncLocalStorage`), run through `streamAttempt` (same multi-step loop as a
  real turn) but NOT streamed to Slack; returns only its final text as a report.
  Pinned to a cheap model via `subagentAttempt` (`packages/ai` — Gemini
  `gemini-3.1-flash-lite` when `GEMINI_API_KEY` is set, else the best
  DigitalOcean BYOK model). Deferred, registered only when a subagent model
  exists. The parent-turn abort signal is forwarded so a stuck subagent is
  killed with the turn.
- **Usage footer** (`agent/index.ts` `postUsageFooter`): after a reply, kyto
  posts a muted Slack **context block** showing `<output tokens> tokens · <N>
  tok/s`, captured from the successful attempt's `result.usage` + elapsed time.
  Per-user opt-out via a new `show_usage_footer` boolean on `user_customizations`
  (default true; additive migration applied to the live DB with a one-off
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS`), toggled from an **Enable/Disable
  button on the App Home tab** (`home_toggle_footer` action, `setUsageFooter`
  query). The finalizer skips the footer when the user set it false
  (`hints.customization.showUsageFooter`). The resolved **model** is shown
  separately in the `Thinking` task (not in this footer).
- **Recurring reminders** (`tools/reminders.ts`, `lib/reminders/scheduler.ts`,
  `@repo/db` schema/queries `reminders`): unlike the pre-existing one-time
  `scheduleReminder` (which uses Slack's native `chat.scheduleMessage` — a
  single future timestamp, no repeat support), recurring reminders are driven
  entirely by kyto's own process since Slack has no recurring-schedule API.
  `scheduleRecurringReminderTool` persists a row (`user_id`, `text`,
  `recurrence: 'interval'|'daily'|'weekly'`, plus the relevant
  `interval_seconds`/`time_of_day_minutes`/`weekday`, and `next_run_at`) to
  Postgres via Drizzle (`packages/db/src/schema/reminders.ts` — a new
  `patchedDependencies`-free table pushed directly with a one-off script since
  `drizzle-kit push` prompted for an interactive rename decision against the
  pre-existing `user_customizations`/`sandbox_sessions` tables in a non-TTY
  shell; `db:generate`/`db:push` should work normally as a human running the
  CLI). `startReminderScheduler` (`index.ts`) runs a `setInterval` (30s) on the
  always-on systemd process that polls `reminders WHERE active AND
  next_run_at <= now()`, posts each via `bot.openDM(userId).post(...)`, then
  advances `next_run_at` to the next occurrence (never deactivates — recurring
  means forever until explicitly cancelled). `listReminders`/`cancelReminder`
  let the model manage a user's own reminders (cancel is scoped by `user_id`,
  so a user can only cancel their own).
  - **Expanded (reminder configuration):** the `reminders` table gained
    `channel_id` (fire into a channel vs DM the user), `max_runs` + `run_count`
    (stop after N fires — `advanceReminder` increments the count and deactivates
    on the cap; all additive migrations applied live). `scheduleRecurringReminder`
    takes optional `channelId` (**owner-only**, same admin gate as cross-channel
    posting; non-owners stay DM-only) and `maxRuns`. New
    `pauseReminder`/`resumeReminder` tools (pause keeps the row but stops it
    firing; resume snaps `next_run_at` to the future). An **App Home
    "Reminders"** section lists each reminder a user may act on with Pause/Resume
    + Delete buttons (`home_pause_reminder`/`home_resume_reminder`/
    `home_cancel_reminder`, `listUserReminders`), tagged with its kind and, when
    someone else created it, `by <@them>`. Reminder posts honor the
    **reminder identity profile** (name+icon). A channel-targeted reminder
    prefixes the text with `<@user>`.
  - **Reminder kinds (July 2026).** `reminders.kind` ∈
    `message | script | bash | agent` (the live `reminder_kind` enum already
    existed — an earlier branch created it — with label order
    `message, script, agent, bash`; Drizzle matches on label, not ordinal).
    Ported from `rebuild-on-upstream` and **reimplemented on the custom
    harness** (the branch's versions import `createAgent`/`openSession`/`Message`
    from the deleted Pi/chat-sdk packages and cannot be cherry-picked):
    - `message` (default): posts `text` verbatim. Unchanged behavior.
    - `script`: fetches `url` each fire and posts its content.
      `fetchUrlText` is now an exported helper in `tools/url.ts`, shared with
      the `fetchUrl` tool.
    - `bash` (`lib/reminders/bash.ts`): runs `command` and posts its exact
      stdout/stderr, **in the persistent sandbox of the thread it was created
      in** (`reminders.thread_id`), holding that thread's sandbox lock. So it
      can run a script kyto wrote earlier. A row without `thread_id` falls back
      to `runOnce` (a throwaway sandbox, empty every fire).
    - `agent` (`lib/reminders/agent.ts`): runs a **headless kyto** — the same
      `streamAttempt` multi-step tool loop as a real turn, full toolset, nothing
      streamed to Slack — with `text` as its instructions, and posts its final
      reply. Pinned to `subagentAttempt` (cheap Gemini flash-lite) so an
      unattended job's cost is predictable. Reuses the thread's sandbox too.
      `searchSlack` does NOT work here (its action token needs a live user
      interaction); the system note says so.
    - **`editReminder`** (July 2026) changes an existing row in place: its
      `text`, `kind`, `command`/`url`, schedule, `maxRuns`, or `editors`. Only
      the fields passed are touched; a new schedule takes effect from **now**
      (`updateReminder` recomputes `next_run_at`), and a bare `intervalSeconds`
      on an interval reminder is re-floored against the (possibly new) kind, so
      an `agent` reminder can't be retuned down to 60s. Gated by the same
      creator/editor/owner rule as pause/resume/cancel.
    - **Interval floors by kind** (`tools/reminders.ts`): `message`/`script` 60s,
      `bash` 5 min (a sandbox resume), `agent` 1 hour (a real model run).
    - The scheduler now fires due reminders **concurrently** (a slow `bash`/
      `agent` fire must not delay everyone else's) and guards against
      **overlapping fires** of the same reminder with an in-flight `Set` — a row
      is only advanced *after* it fires, so every 30s poll during a multi-minute
      run would otherwise start it again.
    - `advanceReminder` now computes the next run from `max(nextRunAt, now)`. A
      schedule left in the past (scheduler downtime) used to re-fire on every
      poll until it caught up — harmless for `message`, a burst of sandbox boots
      or model calls for `bash`/`agent`.
  This durable state is deliberate — a reminder's entire purpose is to outlive
  the turn that created it, same precedent as site hosting, the opt-in
  allowlist, and (now) the per-thread sandbox.
- **`joinThread`/`leaveThread`** (`tools/join-thread.ts`/`tools/leave-thread.ts`):
  let the model opt itself into (or out of) auto-responding to a thread's
  future messages **without** needing a fresh @mention each time. Both just
  toggle the chat-sdk's built-in per-thread state (`respondOnThreadMessages`)
  and `thread.subscribe()`/`unsubscribe()`; `bot.onSubscribedMessage`
  (`apps/bot/src/bot.ts`) is the gate that actually acts on it (responds if
  `respondOnThreadMessages` is true OR the message is a mention). This state
  is durable across restarts (`createPostgresState`, `lib/chat.ts`) — no new
  persistence was added. Note: a mention **inside** an existing thread already
  auto-sets `respondOnThreadMessages: true` (`bot.ts`, `onNewMention`); this
  tool is for the model to join **proactively** (e.g. asked to "keep following
  this thread") without waiting for that implicit trigger.
- **`fetchUrl` rejects Slack links** (`tools/url.ts`, `isSlackLink`): a
  `*.slack.com` URL (message archive/file link) isn't publicly fetchable (302 to
  a login wall), so the tool refuses and points the model at the Slack read tools
  (readConversationHistory for a message — path is `/archives/<CHANNEL>/p<TS>`,
  ts = digits with a dot before the last 6; getFile for a file). Also documented
  in `prompts/slack.ts`.
- **Table blocks are extracted into message text** (`harness/harness.ts`,
  `extractTables`/`collectBlocks`/`richTextPlain`): Slack renders a pasted table
  as a `table` block, but it lives in **`message.attachments[].blocks[]`** (NOT
  top-level `blocks`, and NOT in `event.text`) — verified by fetching a real
  message with the bot token. `collectBlocks` gathers blocks from BOTH
  `event.blocks` and every `attachments[].blocks`; `buildMessage` renders any
  `table` block found as a markdown table and appends it to the message text
  (applies to live messages AND replayed history). Table cells are `rich_text`
  blocks, flattened by `richTextPlain`.
- Slack scopes are declared in `slack-manifest.json` — update it when a tool
  needs a new scope.
- **Email** (`sendEmail`/`checkInbox`/`replyEmail`, `tools/email.ts`) runs
  **host-side** via the AgentMail JS SDK (`agentmail` npm) using
  `AGENTMAIL_API_KEY`. Registered only when that key is set (toolset.ts). It is
  NOT in the sandbox anymore (the key is no longer injected there).
- **Browser** (`browser`, `tools/browser.ts` — renamed from `browse`/`browse.ts`,
  July 2026) runs the preinstalled `agent-browser` CLI **inside the sandbox**
  (Chromium stays isolated off the host). It's a thin wrapper: pass agent-browser
  args in `command` (run `skills get core` first). Using it materializes the lazy
  sandbox. The old `agentmail`/`agent-browser` **Pi skills were removed** — kyto
  now loads **zero Pi skills** (any skill would force per-turn sandbox creation;
  see Sandbox/E2B).
  - **It drives CloakBrowser, not agent-browser's own Chrome**
    (`lib/browser/cloak.ts`, `ensureCloakBrowser`). CloakBrowser is a Chromium
    with ~66 **source-level C++ fingerprint patches** (canvas, WebGL, audio,
    fonts, GPU, WebRTC, automation signals), so anti-bot systems score it as an
    ordinary browser and **most sites never serve a challenge at all**. It does
    NOT solve captchas — it prevents them. Every `browser` call first runs an
    idempotent ensure script that (1) exits immediately if the CDP endpoint on
    :9222 already answers, else (2) installs `cloakbrowser` if missing,
    (3) launches the stealth binary **headful under Xvfb** (some checks flag
    headless even with the patches; falls back to `--headless=new` if Xvfb
    can't be installed) with `--fingerprint-platform=windows`, and (4) runs
    `agent-browser connect 9222` so the CLI drives THAT browser over CDP.
    Re-running matters: a sandbox **pause kills the Chromium process** but keeps
    the ~200MB cached binary, so a resumed thread relaunches in seconds.
    Verified live in a real sandbox: `/json/version` shows the cloak binary,
    `ps` shows it under `xvfb-run`, and in-page `navigator.webdriver === false`
    with a `Win32` platform.
  - `cloakbrowser` + `xvfb` are now baked into the **E2B template**
    (`packages/sandbox/src/scripts/build-template.ts`, binary cached under
    `/home/user` at build time) so the first browse of a thread isn't a ~25s
    install. Until the template is rebuilt the ensure script installs them on
    demand (that path is what was tested).
  - The tool description and the core prompt tell the model: if a captcha DOES
    appear, snapshot the page and **click the checkbox/challenge like a person
    would** — never claim it can't get past one before actually trying.
- **Web search** (the `searchWeb` task) uses Exa via `EXA_API_KEY`. A placeholder
  key (`exa-placeholder-no-websearch`) makes every search return
  `ExaError: Invalid API key` — set a real key to enable web search.
- **Slack search cost** (`tools/search-slack.ts`): `assistant.search.context`
  returns `limit: 10` matches with `include_context_messages: true` (~5 before/5
  after each). The context messages are the **dominant input-token driver** —
  they ride along in every subsequent agentic step, so a few searches balloon a
  turn to 100k–270k input tokens (× premium model pricing = the cost blowup). We
  trim each match's context to the **2 nearest before + 2 nearest after** in the
  result transform (`.slice(-2)` / `.slice(0, 2)`), keeping the relevant
  surrounding thread while slashing prompt size. Drop `limit` or trim bodies
  further if cost climbs again.
- **Slack search modifiers**: `assistant.search.context`'s `query` supports the
  full set of modifiers from Slack's own search bar, all combinable:
  `from:@user`/`from:me`, `to:@user`, `in:#channel`/`in:@user` (DM), `on:`,
  `before:`, `after:`, `during:` (`YYYY-MM-DD` or `YYYY-MM`), `has:link`,
  `has:star`, `has:pin`, `has::emoji_name:` (reaction), `is:thread`, `is:dm`,
  `is:external`, `filename:`, `ext:`. Documented in the tool description and the
  core prompt (`packages/ai/src/prompts/core.ts`) so the model uses them to
  narrow queries instead of filtering broad results itself.
- **Slack search scope**: `assistant.search.context` runs with the *requesting
  user's* own Slack access (not the bot's), so it naturally reaches private
  channels and DMs that user is a member of — but only once the corresponding
  granular OAuth scopes are granted. `search:read.public`/`.files`/`.users` were
  present but `search:read.private`, `.im`, `.mpim` were missing (added to
  `slack-manifest.json`), which silently limited every search to public
  channels only. Needs `bun run sync:manifest` + a reinstall to actually take
  effect (see Manifest sync note).
- **Slack search action-token urgency**: the `action_token` backing
  `assistant.search.context` expires roughly 2 minutes after the turn starts.
  The core prompt now tells the model to run all `searchSlack` calls early in
  the turn (batched with other read-only lookups per the parallel-tool-call
  guidance below), since a search attempted late in a long turn can fail purely
  from token expiry.
- **Parallel tool calls**: Pi **already executes a batch of tool calls
  concurrently by default** — no fork needed. `pi-agent-core`'s
  `executeToolCalls` runs the batch in parallel (`Promise.all`) unless
  `config.toolExecution === 'sequential'` **or** some tool in the batch has
  `executionMode: 'sequential'`; the default `toolExecution` is `"parallel"`, and
  `harness-pi` sets neither, so every kyto tool defaults to parallel. The
  `openai-completions` provider (the HackClub path) also does **not** send
  `parallel_tool_calls: false` (it omits the field → OpenAI-compat default
  `true`), so the model is free to emit several tool calls in one assistant
  message. The **only** lever we have is behavioral: getting the model to actually
  batch calls into a single step. That's driven by the core prompt
  (`packages/ai/src/prompts/core.ts`, "Working in parallel"), which now tells it
  to batch **read-only / side-effect-free** lookups (file reads, Slack/web
  searches, URL fetches, list/get calls) together in one step, and to issue
  **side-effecting** tools (send/edit message, deploy/remove site, canvas
  write/delete, create channel, pin, email, state-changing commands) **one at a
  time**. Per-tool `executionMode` is NOT reachable through harness-pi (the
  `HarnessV1ToolSpec` kyto registers doesn't carry it), so the read-only-only
  restriction is enforced at the **prompt level**, not by tool metadata — marking
  individual writes `sequential` would require patching the `harness-pi`
  node_module. Batching is still model-dependent (a weak model may not batch even
  when told). Faster batched reads also keep a turn under Slack's ~interaction
  timeout, avoiding the "invalid action" token expiry seen on slow serial turns.

### Ownership & edit permission (reminders + sites)
- Things kyto creates **on someone's behalf and can later change** — recurring
  reminders and published static sites — carry an access list, so a bystander in
  a public thread can't ask kyto to rewrite someone's reminder or take down
  their site. The rule, shared by both:
  **the creator, anyone the creator named as an editor, and the bot owner.**
- Set at creation via an optional **`editors`** parameter on
  `scheduleRecurringReminder` and `deploySite` (Slack user ids or `<@U123>`
  mentions; `parseEditors` in `tools/editors.ts` rejects anything that isn't a
  user id, so a display name can't be stored as a permission entry that never
  matches). Omitted = creator only.
- Enforced **at execute time against `message.author.userId`** — i.e. against the
  person actually talking to kyto in this turn, not against whoever the model
  claims to be acting for. Reminders: `isReminderEditableBy` (in-memory) plus
  `editableBy` (the SQL form, a jsonb `@>` containment check) scoping every
  `list`/`pause`/`resume`/`cancel` query; the bot owner gets no WHERE restriction
  at all. Sites: `checkSiteAccess` + `canEdit` (`tools/editors.ts`).
- Storage: `reminders.editor_user_ids` (jsonb, additive) and the new `sites`
  table. Both applied to the live DB with a one-off SQL script
  (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`),
  since `drizzle-kit push` is interactive in a non-TTY shell.
- The core prompt tells the model the rule and that a refusal is not something to
  work around — just say who owns the thing.

### Broadcast mentions (@channel/@here) are owner-gated
- Only the **owner** may make kyto ping the whole channel. `neutralizeBroadcast`
  (`harness/markdown.ts`) downgrades `<!channel>`/`<!here>`/`<!everyone>` (and
  `<!subteam^…>`) to inert plaintext (`@channel`, or the group's name). It's
  applied to the **streamed reply** (`createReply({allowBroadcast})` in
  `agent/reply.ts` — `allowBroadcast = isOwner`, computed in `agent/index.ts`)
  and the **postMessage** tool (`tools/post-message.ts`, non-owner path). The
  core Slack prompt (`prompts/slack.ts`) tells the model broadcasting is
  owner-only. So a non-owner asking "@channel everyone" gets plain text, no ping.

### Broadcast mentions (@channel/@here) rendering
- Slack's newer `markdown` block renders `<@user>`/`<#channel>` links but NOT
  control mentions — `<!channel>`/`<!here>`/`<!everyone>`/`<!subteam^…>` come out
  as **plaintext** there. So `ThreadHandle.post` (`harness/thread.ts`) detects a
  control-mention token (`CONTROL_MENTION` regex) and posts that message as a
  `section`+`mrkdwn` block instead (which resolves them into real pings), losing
  GFM niceties for that message only. The core prompt (`prompts/slack.ts`) tells
  the model to ping people with `<@id>` and broadcast with the raw
  `<!channel>`/`<!here>`/`<!everyone>` tokens (plaintext `@channel` never pings).

### Response style (human tone + no step-by-step narration)
- `prompts/personality.ts`: write like a human in Slack — natural sentence case,
  no Title Case, no ALL CAPS for emphasis, no over-punctuation; casual lowercase
  is fine, match the other person's register.
- `prompts/core.ts` ("Don't narrate every step"): just DO the work then give ONE
  final answer. The tools already show in the plan/thinking UI, so no "let me do
  X / now I'll Y / next I'll Z" running commentary between tool calls, and no
  preamble before them. A brief mid-task status line is allowed ONLY for a long
  multi-phase job or when the user asks to be kept posted — one line per phase,
  never per tool call. This targets chatty agentic models (glm-5.2 etc.) that
  otherwise emit a play-by-play as their first output.

### Focus mode (respond to / see only chosen users in a thread)
- `focusMode` tool (`tools/focus.ts`, core) locks kyto onto specific user ids in
  the current thread: it only replies to those users AND their messages are the
  only ones it sees — non-focused messages are **filtered out of the prompt**
  (`buildPrompt`, via `isFocusAllowed` in `lib/agent/focus.ts`), not just
  ignored, so others can't distract/hijack it in a public thread. The **owner is
  always allowed through** (never lock the owner out) and kyto's own messages
  always stay in context. Gated in `bot.ts` (`onNewMention` +
  `onSubscribedMessage`). Persisted on `thread_subscriptions.focus_user_ids`
  (jsonb; additive migration). Call with `clear: true` to turn it off.

### Slack read-only scripting (host-side proxy)
- `slackScript` tool (`tools/slack-script.ts`, **deferred**, gated on
  `SITES_ENABLED`) runs a bash script in the sandbox for **aggregate** Slack
  questions ("who is in the most channels", "most active user") in one script
  instead of N tool round-trips. It POSTs to a **host-side, secret-gated,
  READ-ONLY proxy** mounted on the public sites server at `/_slackapi/<method>`
  (`lib/slack-proxy/`). The **bot token never enters the sandbox**. The proxy
  attaches the real token and forwards ONLY the `READ_ONLY_METHODS` allowlist
  (users.*, conversations.*, team.*, usergroups.*, reactions/pins/bookmarks list,
  emoji.list) — posting/editing/deleting is impossible through it. This is the
  safe answer to "read-only Slack scripts" (our bot token is NOT itself
  read-only, so it can't just be handed to the sandbox).
- **`slack` is a real executable on PATH now (July 2026)**, not a shell function
  prepended to the `slackScript` tool's script. `slackHelperInstall()`
  (`lib/slack-proxy/`) is passed as `LazySandbox`'s new **`bootstrapCommand`**,
  which runs once each time a sandbox materializes (create AND resume, so it
  must stay idempotent) and writes `/usr/local/bin/slack`. Consequence: the plain
  **`bash` tool** and a recurring **`bash` reminder** can query Slack read-only,
  not just `slackScript`. (The model previously probed `which slack`, found
  nothing, and concluded a scheduled script could never read Slack.)
  - The helper reads `KYTO_SLACK_PROXY[_TOKEN]` **from the environment at call
    time**, and `LazySandbox.run()` re-sends env on every command. That is what
    lets a *persistent* sandbox outlive any single turn's token: a **`bash`/
    `agent` reminder mints a FRESH proxy token at fire time and revokes it after**
    (`reminders/bash.ts`, `reminders/agent.ts`). Without that a scheduled script
    could only ever 401, since the creating turn's token was revoked at turn end.
  - With no proxy env the helper fails loudly (`slack proxy is not available in
    this context`) rather than silently doing nothing.
  - Verified end-to-end against the live proxy: `slack auth.test` → `kyto2`;
    `slack chat.postMessage` → `method_not_allowed: chat.postMessage`; a script
    written by one reminder fire runs on the next.
  - **There is NO search method in the allowlist**, so "count a user's messages"
    means paging `conversations.history` per channel — slow (this is what made a
    real turn take ~14 min), not a bug. Add `search.messages` to
    `READ_ONLY_METHODS` if that's ever wanted (it needs the `search:read` scope).
  - NOTE: the subagent's own sandbox still does NOT get the proxy env, so
    `slackScript` inside a subagent 401s — extend the same way if needed.

### Subagent prompt + its own streamed message
- The subagent runs on a **slimmer system prompt** (`subagentSystemPrompt`,
  `packages/ai/src/prompts/subagent.ts`) — a lean `<subagent>` core + sandbox +
  context, **without** the personality/tone block, the custom-instruction
  hierarchy, the broadcast/mention etiquette, or the media/copyright framing
  (all irrelevant to a headless worker that returns a report). It keeps
  finish-the-job, parallel-tool, loadTools, private-auth, SFW, and report-back
  guidance. Cheaper on the pinned model. `systemPrompt` (the full one) is still
  used for real turns.
- **The subagent posts ITS OWN streamed Slack message** (`tools/subagent.ts`),
  not a card in the parent's plan. It opens a second `slack.stream` (native
  chatStream, `task_display_mode: 'plan'`) authored as **"kyto subagent"** (base
  from `resolveIdentity('subagent')`, + optional `name` arg → "kyto subagent
  {name}") with that identity's icon — chatStream DOES support
  `username`/`icon_emoji`/`icon_url` (needs `chat:write.customize`). The message
  is **ONE collapsible card** (`renderCard`, single `id:'subagent'`) whose
  expanded body holds, in order: **Prompt** (the task), **Tools called** (names
  only), **Thinking** (accumulated reasoning, as kyto shows thinking), and
  **Response** (the subagent's final text). NOTHING goes in the message body —
  the response lives inside the card, not as loose markdown_text. The parent's
  own plan just shows the `runSubagent` tool call; the response is NOT duplicated
  there. `runSubagentTool` still returns the report text to the parent model so
  it can act on it.
  - **Slack takes a task's `output` ONCE, on the update that completes it**
    (fixed July 2026 — the card used to expand to *only* the prompt). The old
    code sent `output` on the FIRST `in_progress` chunk, when nothing but the
    prompt existed yet; Slack froze the card there and ignored every later
    update, including the completing one carrying tools/thinking/response. Now
    progress goes in `details` (`Working… N tool call(s): …`) and the full body
    is only ever sent on the `complete` chunk — the same shape every other task
    in the plan already used (see `ai/stream/index.ts`: `details` while running,
    `output` at completion). Do NOT put `output` on an `in_progress` chunk.
- The old **tool→parent-plan side-channel is gone** (`lib/agent/side-channel.ts`
  deleted; `buildTools`' `emitChunk` param and the `ChunkChannel`/`mergeStream`
  wiring in `agent/index.ts` removed) — the subagent's separate message replaces
  it.

### Identity profiles (per-message-type name suffix + icon, App Home)
- `identity_profiles` table (`message_type` PK ∈ normal|subagent|reminder,
  `name_suffix`, `icon`; additive migration). Owner-configured from an **App
  Home "Identity"** section (owner-gated; `home_edit_identity` →
  `buildIdentityModal` → `home_save_identity`). The base name is ALWAYS "kyto"
  (a suffix is appended, e.g. "kyto subagent"); it can never be renamed.
  `resolveIdentity(type)` (`lib/identity.ts`, 30s cache reset on save) returns
  `{username?, iconEmoji?, iconUrl?}` — `icon` is a `:emoji:` code or an image
  URL (unicode emoji can't be an icon_emoji, so only the `:name:` form passes).
  Applied where kyto posts that kind of message: **reminder** DMs/channel posts
  (name+icon), cross-channel **postMessage** (name+icon), and the **subagent's
  own streamed message** (name+icon, via chatStream's
  `username`/`icon_emoji`/`icon_url`). Needs the `chat:write.customize` scope
  (already in the manifest). NOTE: chatStream DOES accept per-message identity
  overrides (the subagent uses this) — the **main turn's** streamed reply just
  doesn't set them, so "normal" identity currently applies to postMessage, not
  the live reply (could be wired into the main stream the same way if wanted).

### Canvases (read/list/create across channels, channel tab)
- `canvasList` takes an optional `channelId` (raw `C0123`, `slack:` id, or
  `#channel` mention) to inspect another channel; on `not_in_channel` it joins
  the public channel **silently** and retries (no announcement message).
- `canvasWrite` create modes accept `title` (used for both create-standalone and
  create-channel — without it a channel canvas shows as "Untitled").
  `create-channel` then best-effort **adds the canvas as a channel tab** by
  bookmarking its permalink (`addCanvasTab`), since
  `conversations.canvases.create` alone doesn't always surface a header tab. The
  summary says whether the tab was added. Needs `bookmarks:write` + `files:read`.

### Pins (pin in any channel, as bot or owner)
- `pinMessage`/`unpinMessage` take an optional `channelId` (defaults to the
  current channel) and an optional `as: 'bot' | 'user'`. As the bot, a
  `not_in_channel` error triggers one `conversations.join` + retry (public
  channels). `as: 'user'` pins as the owner via `SLACK_USER_TOKEN` and is
  owner-gated (re-checked in-tool). Needs bot `pins:write` and, for `as:'user'`,
  the `pins:write` **user** scope.

### Send/edit-as-owner
- `sendAsUser`/`editAsUser` act AS the owner via `SLACK_USER_TOKEN` (xoxp). Only
  **registered** when `message.author.userId === OWNER_USER_ID` (toolset.ts) and
  each re-checks the author at execute time. Config: `SLACK_USER_TOKEN`,
  `OWNER_USER_ID`; requires the `chat:write` **user** scope.

### Static site hosting
- `deploySite`/`removeSite`/`listSites` publish/manage prebuilt static sites at
  the **host root**: `https://<host>/<name>/` (default host
  `kyto.devansh.hackclub.app`). Code in `apps/bot/src/lib/sites/`. The host NEVER
  executes site code — building/testing happen in the E2B sandbox; only static
  output is copied out (`resolveWithin` path containment). The on-disk store is
  still `SITES_ROOT` (`/var/kytosites`). `listSites` (core) enumerates the
  published sites (top-level dirs under the sites root).
- **Sites are owned, and `removeSite` is no longer owner-only** (July 2026). A
  new **`sites`** table (`name` PK, `owner_user_id`, `editor_user_ids` jsonb)
  records who published each name. `deploySite`/`removeSite` are registered for
  everyone and gated at execute time by `checkSiteAccess` (see the
  Ownership/edit-permission note): the first deploy of a name **claims** it for
  the requester; later deploys or a removal require creator/editor/owner. A
  whole-site `removeSite` releases the name (`deleteSite`); removing one `page`
  does not. Sites published **before** the table existed have no row: they exist
  on disk, so `siteExistsOnDisk` makes them **bot-owner-only** rather than free
  for the next person to claim (otherwise anyone could redeploy over them).
- **Image generation** (`tools/generate-image.ts`) calls HackClub's
  OpenAI-compatible `/images/generations` endpoint **directly** (fetch, model
  `google/gemini-3.1-flash-image`, billed to `HACKCLUB_API_KEY`), parsing
  `data[].b64_json` and detecting the media type from magic bytes. The old path
  went through the AI SDK's `generateImage` + `@openrouter/ai-sdk-provider`
  `imageModel`, which never actually reached the endpoint (the "image gen not
  working" bug). `provider.imageModel` in `packages/ai` is now unused by this
  tool.
- **Multi-page sites:** both tools take an optional `page` sub-path (e.g. `home`
  or `docs/intro`), served at `https://<host>/<name>/<page>/`. A page deploy
  atomically swaps only that sub-path and leaves the rest of the site intact, so
  a site's pages can be published/removed one at a time; omit `page` to
  publish/replace (or remove) the whole site at the root. Page paths are
  validated by `isValidPagePath` (lowercase slug segments split on `/`) on top of
  `resolveWithin` containment.
- Server starts from `apps/bot/src/index.ts` (`startSitesServer`), binds
  `SITES_PORT` (default **8080**). Serves **plain HTTP by default** because it
  sits behind Nest's TLS-terminating proxy (serving HTTPS there → 502). Set
  `SITES_TLS=true` for a self-signed HTTPS cert (standalone/local).
  `SITES_PUBLIC_HOST` (default `kyto.devansh.hackclub.app`) builds the public URL
  (always `https://`). Config: `SITES_ENABLED`, `SITES_PORT`, `SITES_TLS`,
  `SITES_ROOT`, `SITES_PUBLIC_HOST`.

### Manifest sync
- `bun run sync:manifest` (apps/bot) pushes `slack-manifest.json` to the Slack
  app config via `apps.manifest.update`. Needs a Slack **app configuration
  token** (not the bot/user token): `SLACK_APP_ID`, `SLACK_CONFIG_ACCESS_TOKEN`,
  and optional `SLACK_CONFIG_REFRESH_TOKEN` (auto-rotates the short-lived access
  token first). Scope changes require reinstalling the app.

### Running the bot / debugging "kyto isn't responding"
- The bot runs under **systemd** (`kyto.service`, unit at `deploy/kyto.service`).
  `systemctl status kyto.service` / `journalctl -u kyto.service -f -o cat`. It
  auto-restarts (`Restart=always`) and starts on boot. Two other unrelated Slack
  apps also run on this host (`slackbot.service` = `/root/slack-ai-helper`, a Q&A
  helper; `hackclub-ai-status-bot.service`) — different apps/tokens, they don't
  interfere.
- **Never hand-launch a second copy** (`bun run start:bot`). Each running process
  opens its own **Socket Mode** connection, and Slack delivers each event to only
  ONE connection, so a stray manual instance silently steals ~half the mentions.
  Diagnose the connection count with Slack's `hello` frame `num_connections` (open
  a throwaway socket via `apps.connections.open` with `SLACK_APP_TOKEN` and read
  the first frame) — it should be **1** (just the service).
- **The app's live username is `gorkie__devansh_`** (immutable, gorkie-era) but
  the **display name is `kyto`**, so `@kyto` DOES resolve to this bot
  (`U0BD3555UCQ`, app `A0BCA6D6GAV`). `auth.test`'s `user` field returns the
  username, not the display name — don't be fooled into thinking `@kyto` is a
  different app.
- **Slash commands work but @mentions/DMs don't = Event Subscriptions are off.**
  Slack Socket Mode routes slash commands, interactivity, and event-subscription
  events independently; if the **Enable Events** master toggle is off (it silently
  turned off once), `slash_commands` still deliver over the socket while
  `app_mention` / `message.*` deliver **nothing**, and the bot logs only startup
  lines (it never sees the event). Fix: re-enable Event Subscriptions in the app
  config (and reinstall if scopes changed). Confirm by opening a throwaway socket
  and mentioning the bot — you should see an `app_mention` envelope arrive.
- **Zombie socket:** a dropped Socket Mode WSS can stay TCP-`ESTAB` locally with a
  stuck send-queue (`ss -tnp | grep :443` shows non-zero Send-Q) while delivering
  nothing; `systemctl restart kyto.service` re-establishes a clean connection.

### Models / LLM model router + fallback
- **PRIMARY IS NOW PINNED GLM 5.2, not Sonnet 5.** `ROUTER_MODEL = 'z-ai/glm-5.2'`
  (`packages/ai/src/providers/attempts.ts`), reached through HackClub. Switched
  from `anthropic/claude-sonnet-5` because GLM 5.2 is far cheaper per token
  (Sonnet is $2/$10), which stretches the daily HackClub $3 cap much further.
  glm-5.2 is also a rung in `LEADERBOARD_FALLBACK`, deduped via `failedKeys` so
  it isn't retried on fallback. (When the HackClub budget is exhausted, the
  primary 403s "daily limit" → `hackclubBudgetExhausted` → straight to the
  DigitalOcean BYOK tier, which serves glm-5.2 too.)
- **Gemini tool use fixed (thought_signature replay)** (`packages/ai/src/agent.ts`):
  Gemini 3.x attaches an encrypted `thought_signature` to every function call
  and REQUIRES it echoed back on the next turn, or Google 400s ("Function call
  is missing a thought_signature"). The `@ai-sdk/openai-compatible` provider
  drops that field when replaying assistant tool calls, which broke ALL
  multi-step Gemini tool turns after the rewrite (worked pre-rewrite on the Pi
  stack). Fixed in `tunedFetch`: for `provider === 'gemini'` it tees each
  response, captures `extra_content.google.thought_signature` per tool-call id
  (`captureThoughtSignatures`), and re-injects them into subsequent request
  bodies' assistant tool calls (`injectThoughtSignatures`). Verified end-to-end
  (2-step tool loop completes). A dummy/placeholder signature is rejected
  ("Corrupted thought signature"), so real capture is mandatory.
- **The DigitalOcean BYOK tier goes through openrouter.ai, NOT baishui.** The
  `.env` had `OPENROUTER_BASE_URL=https://baishui.jam06452.uk/v1`, but baishui
  rejects our OpenRouter key with "invalid API key" on every call (including
  `/models`) — so the whole DO fallback tier was dead. The key itself is valid
  on real openrouter.ai (`/api/v1/key` shows active BYOK: ~$2.95/day DO usage),
  and DO completions succeed there with the code's existing model names
  (`glm-5.2` → `z-ai/glm-5.2-…` on `provider: DigitalOcean`). Fixed by setting
  `OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"` in `.env`. Do NOT point it
  back at baishui unless a real baishui key + its own model names
  (`glm5.2-normal`, `dsv4-fast`, …) are wired up.
- **[historical] PINNED SONNET 5 era:** `ROUTER_MODEL = 'anthropic/claude-sonnet-5'`.
  The
  auto-router was dropped (owner's call) because its per-request re-routing was
  flaky — empty completions / wrong-model picks that triggered long fallback
  cascades. `agent.ts` no longer injects the `auto-router` plugin
  (`ALLOWED_MODELS`/`COST_QUALITY_TRADEOFF` are retained but UNUSED, kept for
  reference). The fallback machinery is otherwise unchanged: sonnet-5 is
  attempt 0; on failure the pinned-resolved-retry is skipped (sonnet-5 already
  failed, dedup via `failedKeys`) and it walks `LEADERBOARD_FALLBACK` best→worst
  (sonnet-5 isn't in that list, so `findIndex` = -1 → full leaderboard). NOTE:
  switching primary does NOT help on a **HackClub daily-budget-exhausted** day —
  sonnet-5 is a HackClub call and 429s too, flipping `hackclubBudgetExhausted`
  to skip straight to the DigitalOcean BYOK tier then the owner's Gemini key
  (that's what serves requests once the $3/day cap is hit; resets at UK
  midnight). The old auto-router doc below (auto plugin, resolved-model capture)
  is historical.
- **Prompt cache is now 1-HOUR TTL** (`agent.ts` `CACHE_CONTROL = {ttl:'1h',
  type:'ephemeral'}`), so the system+tools prefix stays cached across a thread's
  sporadic turns, not just within one multi-step loop. Anthropic/OpenRouter
  honor `ttl:'1h'`; other providers ignore it.
- **[historical] auto-router era:** The main query used to run on OpenRouter's
  own auto-router via HackClub (`openrouter/auto`); the HackClub proxy is
  OpenRouter-compatible. This replaced the old per-request router-LLM hop
  (`pickModel`/`buildRoutingContext`, deleted) and the
  `meta-llama/llama-3.3-70b-instruct` fast tier, which was unreliable for tool
  use (hallucinated tool names, wrong-bot/persona confusion, stray "battles").
- **Fallback on failure** (`agent/index.ts`, `routeNextAttempt`): `openrouter/auto`
  is attempt 0. On any error or empty completion it (1) retries the **exact model
  auto resolved to**, pinned via HackClub (auto's failure is often transient/an
  empty completion), then (2) walks the `LEADERBOARD_FALLBACK` list (`attempts.ts`)
  **UP** from that model toward the best (closest-better first), then **DOWN**
  toward the weakest. `LEADERBOARD_FALLBACK` is the owner's arena leaderboard,
  best→worst, restricted to reachable models: the strong tier on HackClub
  (opus-4.8/4.7/4.6, gpt-5.5/5.4, glm-5.2/5.1, sonnet-4.6), then the rest of the
  leaderboard appended in rank order (kimi-k2.7-code, gemini-3.5-flash,
  deepseek-v4-flash, kimi-k2.6, minimax-m3, deepseek-v4-pro,
  qwen3.6-plus, grok-4.3, grok-build-0.1, gemini-3-flash-preview, minimax-m2.7,
  nemotron-3-ultra-550b-a55b — all verified present on
  `ai.hackclub.com/proxy/v1/models`). Claude Fable 5 is also reachable there now
  (`anthropic/claude-fable-5`) but deliberately excluded — ~2x opus-4.8's
  per-token cost, not worth it against the daily HackClub spend cap.
  gemini-3.5-flash was previously excluded here too for a confirmed
  100%-empty-response failure, then re-added at the owner's request (see
  below) — re-remove if the failure recurs. `gemini-3.1-pro-preview` was
  re-added at the same time but then dropped again (2026-07-06, owner: too
  expensive for the quality it delivers against this daily budget) — removed
  from here, `ALLOWED_MODELS` (`packages/ai/src/agent.ts`), and `GEMINI_MODELS`
  (`attempts.ts`).
  The **baishui proxy** tail (`jam06452.uk`) is **commented out** — its `/models`
  endpoint answers but every completion fails ("upstream authentication failed" /
  "all provider keys rate-limited or in cooldown"), so it only wasted fallback
  attempts; re-enable the block (with `proxyAttempt`/`proxyReady`) only after
  verifying a real completion succeeds. **Last resort: the owner's own Gemini
  key** (`geminiAttempts`, `GEMINI_API_KEY`, direct Google endpoint, provider
  `gemini`) is appended to the very end of `LEADERBOARD_FALLBACK`, so a fully
  budget-exhausted HackClub day still gets an answer off a separate, cheap quota;
  skipped if `GEMINI_API_KEY` is unset. Fable 5 (rank #1) is reachable on
  HackClub (`anthropic/claude-fable-5`) but deliberately excluded from both
  `LEADERBOARD_FALLBACK` and the auto-router allowlist — ~2x opus-4.8's
  per-token cost, not worth it against the daily HackClub spend cap. The
  resolved slug is read off the per-turn model holder (`autoHolder`)
  captured during the auto attempt, so it pins/pivots even when auto failed. Each
  entry is tried at most once (tracked via `failedKeys`). `deepFallbackAttempts`
  is retained/exported for reference but no longer drives routing.
- **DigitalOcean BYOK tier** (`digitaloceanAttempts`, provider `openrouter-do`,
  `attempts.ts`): the owner's OpenRouter key (`OPENROUTER_API_KEY`) holds **$0
  OpenRouter credit** but is configured with **BYOK to DigitalOcean**, so
  DigitalOcean-served models run at **$0 OpenRouter cost** (billed to the owner's
  DigitalOcean account — a quota SEPARATE from HackClub). Reached via
  `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1` — NOT `/v1`,
  which returns the marketing site). `agent.ts`'s `tuneBody` injects `provider:
  { only: ['digitalocean'] }` on every `openrouter-do` request — **required**,
  since with $0 credit OpenRouter would otherwise route to a paid provider and
  402. Roster = the **verified tool-capable** DO models only (`DIGITALOCEAN_MODELS`,
  best→worst: glm-5.2, deepseek-v4-pro, kimi-k2.6, qwen3.5-397b-a17b,
  minimax-m2.5, glm-5, deepseek-v4-flash, llama-4-maverick, mimo-v2.5-pro).
  **`gpt-oss-120b` and `kimi-k2.5` are excluded** — DigitalOcean's endpoints for
  them reject tool use, useless for kyto's tool loop. These are short BYOK
  aliases (OpenRouter resolves `glm-5.2` → `z-ai/glm-5.2-…`); the `-fast`/
  `-normal` proxy aliases in the owner's raw list are NOT valid OpenRouter ids.
  Appended to `LEADERBOARD_FALLBACK` **before** the Gemini last resort;
  `maxOutputTokens` caps their (reasoning-model) output like HackClub's.
- **Prompt caching** (`agent.ts` `addCacheControl`): `tuneBody` injects
  `cache_control: {type:'ephemeral'}` breakpoints on the **system message**
  (tools+system prefix — the big constant chunk) and the **last user message**
  (the replayed thread history), so within a multi-step tool loop every step
  reads the cached prefix instead of re-billing it. Verified through the HackClub
  proxy: Anthropic honors it for a **~10x cheaper cached read** ($0.0206 write →
  $0.0019 read on a 3.2k-token prefix); the HackClub proxy passes `cache_control`
  straight through to OpenRouter. Providers without explicit caching (OpenAI,
  DeepSeek, GLM, Kimi, …) **safely ignore** the field (confirmed no error on
  glm-5.2/deepseek/auto→gpt-5.5) and auto-cache on their own; DigitalOcean
  already returned `cached_tokens` on a plain call. Applied to every attempt —
  harmless where unsupported. Anthropic allows ≤4 breakpoints; we use 2, both on
  content the SDK sends as plain strings (system, user), leaving assistant/tool
  messages untouched.
- **One fallback, not two (July 2026).** Three things made a dead HackClub cost
  several `Thinking · fallback` cards and minutes of latency:
  1. **The AI SDK retries internally.** `streamText` defaulted to 3 tries per
     attempt, so every rung waited out three 429s before our router saw it.
     `streamAttempt` now sets **`maxRetries: 1`** (`packages/ai/src/agent.ts`) —
     we run our own cross-provider fallback, so SDK-level retries just multiply
     the wait. One retry still absorbs a transient blip.
  2. **The budget 403 was invisible.** HackClub returns OpenRouter's
     `403 {"error":{"message":"Key limit exceeded (daily limit)"}}` (and
     sometimes a bare 429), but the SDK rethrows an **`AI_RetryError`** whose own
     message is only "Failed after 3 attempts…" — `responseBody` hangs off the
     *wrapped* errors. The old shallow readers missed it, so a budget-exhausted
     day looked like a generic failure. **`deepErrorText`** (`lib/utils/error.ts`)
     now recurses through `lastError`/`cause`/`errors` (depth-capped, so a cyclic
     `cause` can't hang the router) and both call sites use it —
     `thrownErrorText` (agent) and the stream `error` part (`ai/stream/index.ts`,
     whose duplicate `errorPartText` was deleted). `SPEND_LIMIT_PATTERN` gained
     `limit exceeded`.
  3. **`HACKCLUB_OUTAGE_THRESHOLD` is now 1**, not 2. Every HackClub rung shares
     one proxy and one budget, so a rung failing for a non-model reason means the
     next fails identically; trying a second only bought another fallback card
     before the same verdict. DigitalOcean BYOK is a genuinely separate quota.
  Net: a HackClub outage or budget-exhaustion now reaches DigitalOcean in **one**
  fallback.
- **HackClub outage failover → skip the rest of HackClub** (`agent/index.ts`):
  distinct from the spend-limit case below. When HackClub itself is DOWN (5xx /
  connection errors, not budget), every HackClub rung would fail identically, so
  walking the whole HackClub-heavy leaderboard produced a long useless cascade
  (the "lots of Thinking · fallback, sometimes no reply" bug). Now a per-turn
  `hackclubFailures` counter (non-budget HackClub failures only) trips
  `hackclubUnavailable` after `HACKCLUB_OUTAGE_THRESHOLD` (1) failure, which —
  like `hackclubBudgetExhausted` — makes `buildFallbackQueue` and the
  attempt-selection `.find` **skip all remaining HackClub rungs** and jump to the
  DigitalOcean BYOK tier, then the owner's Gemini key. So a full HackClub outage
  reaches a working model in ~3 attempts instead of ~15.
- **HackClub spend-limit failover → straight to Gemini**: if a HackClub call
  returns the daily-spend 429 (`SPEND_LIMIT_PATTERN`, surfaced via
  `renderStream`'s `onError`), `routeNextAttempt` sets `hackclubBudgetExhausted`.
  The whole HackClub budget is **shared**, so once the first call 429s every other
  HackClub rung 429s the same way (they just burn attempts at ~4ms each). So the
  flag flips `buildFallbackQueue` to **skip all HackClub rungs and go to the
  non-HackClub rungs**: the **DigitalOcean BYOK tier first** (separate quota,
  strong tool-capable models), then the owner's Gemini key
  (`geminiAttempts`, separate quota, cheap) as the final backstop. (Order is
  `[...otherNonHackclub, ...gemini]` — DO before Gemini, since DO's models are
  far better than the cheap Gemini rung.) The pinned resolved-model retry is also
  skipped on spend-limit (it's a HackClub call).
  (This replaced the older cheapest-first-HackClub-retry approach — the
  pessimistic-limit "a cheap rung might still fit" recovery wasn't worth the
  wasted 429 attempts once the Gemini key exists as a clean, cheap escape.)
- **Fetch interceptor** (now `packages/ai/src/agent.ts`, per-provider `fetch` — no global patching): Pi makes model calls through the process-global `fetch` (undici),
  so we patch it to tune the request and read the response:
  - **Tune the auto-router**: inject the `auto-router` plugin into the
    `openrouter/auto` request body with `cost_quality_tradeoff` (0 = best/dearest,
    7 = default, 10 = cheapest; we use **7** — the default, biased away from the
    always-premium routing that blew up cost) and an **`allowed_models`** allowlist
    of **exact slugs** (the field is `allowed_models` — the older `model_patterns`
    name is silently ignored by the proxy; not globs, so no
    `-nano`/`-mini`/`-flash-lite`/`-fast` or `claude-fable-5` leakage):
    claude-opus-4.6/4.7/4.8, claude-sonnet-5, claude-sonnet-4.6, gpt-5.4/5.5, glm-5.1/5.2,
    **gemini-3.1-flash-lite** (the cheap rung — added so auto
    can route simple/casual turns off the premium tier, the main cost blowup, and
    as the signal for handing a turn to the owner's Gemini key), plus
    `gemini-3.5-flash` (re-added 2026-07-02 at the owner's request after
    previously being removed for returning an **empty response on 100% of
    observed attempts** — 22/22 direct via `geminiAttempts`/`GEMINI_MODELS` in
    `attempts.ts`, 10/10 via the auto-router's `google/gemini-3.5-flash` slug in
    `LEADERBOARD_FALLBACK`). The owner's Google AI Studio dashboard showed
    **zero requests metered** against it despite these attempts, meaning the
    calls were rejected before reaching generation (likely not enabled for a
    free-tier key at the time), not that the model burned its output budget on
    thinking; it also only carries a 20 RPD free-tier quota vs.
    3.1-flash-lite's 500 RPD. Because of that dashboard signal,
    `gemini-3.5-flash` was kept OUT of `GEMINI_MODELS` (`attempts.ts`, the direct-key
    path) when re-adding it here and to `LEADERBOARD_FALLBACK` — the
    HackClub-proxied call is a different request path and may not be
    tier-gated the same way. If the empty-response failure recurs, watch
    `[stream] tally` in the logs (0 textDeltas/reasoningParts despite tool
    activity) and re-remove from `ALLOWED_MODELS` (here) and
    `LEADERBOARD_FALLBACK` (`attempts.ts`). `gemini-3.1-pro-preview` was also
    re-added at the same time, then dropped again 2026-07-06 (owner: too
    expensive) from all three of `ALLOWED_MODELS` (here), `LEADERBOARD_FALLBACK`
    (`attempts.ts`), and `GEMINI_MODELS` (`attempts.ts`) — it's not known to have the
    dashboard/empty-response issue, this was purely a cost call. The
    interceptor strips a stale `Content-Length` when re-issuing the tuned
    (longer) body so the appended `plugins` isn't truncated. Verified honored
    by the HackClub proxy. Edit `COST_QUALITY_TRADEOFF`/`ALLOWED_MODELS`.
  - **Cap `max_tokens` on HackClub requests** (`MAX_OUTPUT_TOKENS = 8000`): the
    HackClub proxy enforces its **daily spend limit pessimistically** — with no
    `max_tokens` it assumes the model could emit its full max output, projects
    that worst-case cost, and returns `429 Daily spending limit of $3 reached`
    when the projection crosses the cap **even with budget still free** (the
    dearer models — opus/gpt-5.x — were rejected at $2.33/$3 while cheap GLM went
    through). Injecting `max_tokens` makes OpenRouter price off that bound, so
    requests pass (verified: opus-4.8 429s without it, succeeds with it). Sized
    to past usage: observed step outputs run **<6k tokens**, so 8k is generous
    headroom while halving the projected cost vs. the old 16k — the lower
    projection is what lets the cheaper HackClub rungs still fit near the budget
    end (so the spend-limit fallback above can recover on HackClub). Applied only
    to HackClub URLs (the baishui proxy is unmetered). Edit `MAX_OUTPUT_TOKENS`;
    raise it if large single-step file writes get truncated.
  - **Capture the resolved model**: the stream only exposes the *requested* id, so
    we read the concrete model OpenRouter resolved to from the `model` field of a
    clone of the response and stash it per-turn (`AsyncLocalStorage`).
- The turn's work is surfaced as a **`Thinking` task in the thinking section**
  (title `Thinking`, or `Thinking · fallback` on retries). The **model name is
  deliberately NOT shown** (owner's call) — `completeModelTask` emits no `output`
  at all (it previously appended `provider · model → <resolved>`). Reasoning
  tokens the model streams also render under the title **`Thinking`**
  (`stream/index.ts`, renamed from `Reasoning`) so the plan uses a single word
  rather than both `Thinking` and `Reasoning`. (The model task and reasoning
  task are still separate task ids, so a reasoning turn shows two `Thinking`
  rows; merging into literally one card is a possible follow-up.)
  Emitted **`in_progress` while the attempt runs** (so the activity indicator reads
  as working, never a misleading "completed" before anything has happened) and
  marked **`complete` exactly once** via the `completeModelTask()` guard
  (`modelTaskDone`): the post-stream success path completes it, and the catch
  completes it only if that hasn't already fired (so an attempt that throws before
  post-stream still stops the `Model · fallback` spinner). The single-completion
  guard fixes a **display bug where each model rendered 2–3×**: a streamed attempt
  that then failed the empty-check completed the task post-stream (with the
  resolved arrow) AND again in the catch (plain), so the plan showed the same
  model repeated. `modelHolder`/`modelTaskId`/`modelTaskTitle` are declared
  outside the per-attempt try so the catch can read them. Updated in place by id
  to append the resolved model. `openrouter/auto` re-routes **per step**, so a turn can use several
  models; the task shows the **first** step's pick (every step is logged at info
  as `[router] resolved openrouter/auto model`).
- `MODEL_CATALOG`/`CATALOG_IDS` are retained for reference/diagnostics only (no
  longer drive routing). `chatAttempts`/`attemptsFor`/`PREMIUM_MODEL` remain
  exported for reference.
- Fallback advances on **any** error AND on an **un-handled completion**. A turn
  counts as **handled** iff it produced reply text or a deliberate `skip`.
- **"Ends its turn without responding" (fixed July 2026).** `handled` used to
  also accept `producedToolActivity && sawCleanStop` — a model that ran its
  tools and then finished with `finishReason: 'stop'` and **zero text** counted
  as handled, so no fallback fired; and since the streamed reply is created
  lazily on the first text delta, **nothing was posted at all**. The user saw
  tool cards and then silence. (That clause was itself the fix for the opposite
  "stops mid-task" bug — a cascade after the model deliberately finished — but
  it was drawn too wide: the deliberate no-reply path is the `skip` tool, which
  is tracked separately.) Now that case runs `synthesizeFinalAnswer`
  (`agent/index.ts`): re-ask **the same model, once, with `tools: {}`**, feeding
  it the task plus `renderCarryover(gatheredResults)` and "you already did the
  work, write the final reply now". Tools are off, so no side effect can fire
  twice, and it costs one cheap call. If the nudge is also empty the turn is
  **unhandled** and falls back to the next model, which replays the same
  gathered results. `sawCleanStop` (from `onFinish`) now only gates the nudge.
  A truly empty completion (no text, skip, or tools) falls back as before. Any
  provider placeholder text like `(Empty response: ...)` is dropped before it
  reaches Slack (`agent/index.ts`, `ai/stream/index.ts`).
- **Tool-result carryover across fallback**: so a fallback model doesn't re-run
  the same tools (e.g. repeat identical web searches) after an earlier step
  truncated, `renderStream`'s `onToolResult` reports every completed
  (non-phantom, non-`skip`) tool call's input+output. The agent stashes them in
  `gatheredResults` (deduped by tool+input via `gatheredKeys`). On a **fallback**
  attempt (`attempts.length > 0`) the prompt is augmented with `renderCarryover`
  — a "previous attempt already ran these tools, answer from them, do NOT re-run"
  block — so the new model continues from the gathered results. Bounded to avoid
  context blow-up: last `CARRYOVER_MAX_RESULTS` (12) results, each clamped to
  `CARRYOVER_OUTPUT_MAX` (1500) / `CARRYOVER_INPUT_MAX` (400) chars. The first
  attempt always sends the plain prompt. NOTE: this is a prompt-level replay, not
  true session continuation — each attempt is still a fresh Pi session/model (the
  harness session history is owned per-runtime and isn't transferred across
  different models), so the carried results are re-sent as text, not resumed.
- **Daily-budget failure message**: when a turn fails after the HackClub
  spend-limit 429 cascaded through every fallback, `agent/index.ts` throws
  `BudgetExhaustedError` (carrying the raw 429 text), and `agentErrorMessage`
  (`lib/errors.ts`) renders a plain message naming the cap and the reset
  countdown — _"kyto's daily model budget ($3/day) is used up … it resets at UK
  midnight, in Xh Ym"_ — instead of the generic "oops". The reset clock
  (`timeUntilUkReset`) counts down to the next **Europe/London** midnight (tracks
  BST/GMT automatically, computed from London wall-clock so it's host-tz
  independent). It deliberately does **not** explain OpenRouter's pessimistic
  limit accounting. The dollar amount is parsed from the 429 text (defaults to
  $3). This wins over the stage-based (`after_text`/`after_progress`) messages
  since the budget is the real cause.
- **Hallucinated tool calls are hidden.** Weak models sometimes emit a tool call
  to a tool we never registered (observed: a mangled name `" analemma"`); the
  harness returns a `"Tool X not found"` tool-result and the model recovers next
  step. `renderStream` is passed `knownTools` and drops any tool-call (and its
  matching result/error) whose name isn't registered, so phantom calls never
  surface as activity tasks (`ai/stream/index.ts`).
- No **Stop button** is posted during a turn (removed from `postControls` flow).
- **Per-attempt watchdog** (`agent/index.ts`, `ATTEMPT_TIMEOUT_MS`, default 10m,
  env `AGENT_ATTEMPT_TIMEOUT_MS`): each model attempt runs under a dedicated
  `AbortController` combined with the turn controller via `AbortSignal.any`. If
  the attempt stalls (a frozen upstream SSE stream or a hung tool that never
  returns) the timer aborts **only the attempt signal**, so it is NOT mistaken
  for a user interrupt — it routes through the normal recovery path (fall back to
  the next model if no reply text streamed yet, else surface an error). The
  combined signal also reaches tool execution: sandbox tools that forward it
  (`browser` passes `abortSignal` into `session.run`) get their hung command
  killed, unblocking Pi. Without this a turn could hang forever (observed: a
  website-build turn froze after an "On it…" preamble + a browser open that never
  returned). Other sandbox tools (`deploySite`, `getFile`, `uploadFile`) do not
  yet forward the signal — extend them the same way if they're seen to hang.
- `glm-4.7` is omitted from HackClub (persistent 504); `glm-5.2` 504s
  intermittently there but degrades via the empty-completion fallback (baishui is
  disabled, so no `glm5.2-normal` backstop).

### Identity & opt-in gating
- **The bot's Slack username is a gorkie-era handle (`gorkie__devansh_`)** — the
  app was forked from gorkie and the handle stuck (display name shows "Not set"
  live even though `slack-manifest.json` says `kyto`; the manifest needs syncing
  + reinstall to update it). Because of this, `annotateMentions`
  (`lib/agent/mentions.ts`) special-cases the bot's own id (`slack.botUserId`) and
  annotates it as `kyto`, so the agent never mistakes its own mention for gorkie.
- **Opt-in gating** (`OPT_IN_CHANNEL`): an un-opted-in user who @s kyto gets
  `offerOptIn` (`lib/onboarding.ts`) — a **visible in-thread reply** (not
  ephemeral) with an "i accept" button, mirroring how gorkie surfaces its join
  gate. Membership of `OPT_IN_CHANNEL` is the allowlist (`lib/allowed-users.ts`).
- **`##` messages are invisible to kyto.** A message with any line that begins
  with `##` (after stripping leading @mentions) is a human-only side-channel:
  `isHiddenFromBot` (`lib/utils/message.ts`) makes `shouldIgnore` (`bot.ts`) skip
  it AND `buildPrompt` (`lib/agent/prompt.ts`) filter it out of the replayed
  thread history — so kyto never triggers on it and never even sees it in
  context. (Previously it was only non-triggering but still visible in history.)
- **No channel-join greeting at all.** The `member_joined_channel` handler
  (`features/assistant/index.ts`) posts **nothing** — the welcome line was
  removed entirely per workspace admins (an earlier inviter-gated version still
  wasn't acceptable). Ban history: kyto once auto-joined a **post-restricted**
  channel to search it and the greeting posted where normal members can't,
  getting it banned. Do NOT re-add any `member_joined_channel` post. General
  rule: kyto only ever speaks in **reply to being invoked**, never unsolicited.
- **Cross-channel posting is owner-gated** (`tools/post-message.ts`). The
  `postMessage` tool takes `currentThreadId` + `isOwner`; for a **non-owner** it
  may only post back into the **same channel** kyto was mentioned in (a
  different-channel target or a DM to another user is refused). The **owner** can
  still direct it to post into any channel. This is the admin requirement that a
  thread in #general can't be used (by anyone but the owner) to post into
  #announcements. `sendAsUser`/`editAsUser` remain owner-only already.
- **Kyto is closed-source.** `packages/ai/src/prompts/slack.ts` states plainly
  that Kyto's own code is private with no public repo link to share (it
  started as a private fork of the open-source gorkie project, but that's as
  far as the public trail goes). This replaced an earlier line that
  (incorrectly) told users Kyto's source was available at
  `github.com/imdevarsh/gorkie-slack` — that's the upstream fork source, not
  Kyto's own repo, and it isn't public.
- **Owner grounding**: without it, asked "who coded you", kyto had confabulated
  answers like "a team of engineers at a private organization" and disputed
  the truth when the real owner said so. `RequestHints.ownerUserId` (from
  `OWNER_USER_ID`, populated in `apps/bot/src/lib/ai/hints.ts`) is rendered
  into the context block (`packages/ai/src/prompts/context.ts`) as a plain
  statement of who owns/built Kyto, with an explicit instruction not to hedge
  or invent a different origin. Skipped if `OWNER_USER_ID` is unset.
- **`main` is the branch actually deployed** (`kyto.service`'s working
  directory tracks whatever is checked out here). A separate branch,
  `rebuild-on-upstream`, diverged with its own version of these identity fixes
  plus unrelated features (MCP client, `gh` CLI tool, `/btw` side-channel,
  Replicate TTS) — it was never merged and is **not** the source of truth for
  this doc. Don't assume anything on that branch is live; re-derive fixes
  directly on `main` instead of assuming a merge will happen.
- **Branch audit (2026-07-09): `main` is now a strict superset of
  `rebuild-on-upstream`, feature-wise.** The last thing that branch had and
  `main` didn't was the reminder kinds (`script`/`bash`/`agent`) + `run-once.ts`,
  now ported. Everything else that looks "new" over there is *older* Pi/chat-sdk
  infrastructure (`session.ts`, `skills.ts`, `provider.ts`, `providers/pi.ts`,
  `resolved-model.ts`, `controls.ts`). `main` additionally has focus mode,
  `slack-script.ts`, the sandbox tools, MCP, identity profiles, and the subagent
  prompt — none of which exist on the branch. Nothing further to harvest; the
  branch's `MAX_RECURRING_RUNS = 20` global auto-cancel was deliberately NOT
  ported (it would silently kill existing "forever" reminders; `max_runs` is
  already opt-in per reminder).

### DM threading (native in the custom harness)
- **Every message threads, DMs included.** The custom harness assigns
  `threadTs = event.thread_ts || event.ts` unconditionally (`buildMessage`,
  `apps/bot/src/harness/harness.ts`) — the behavior the old adapter needed a
  `bun patch` for is now just how the harness works (the patch and
  `patchedDependencies` are gone). A top-level DM message starts (and kyto
  replies within) its own thread; `buildPrompt` scopes context to just that
  thread, so kyto has no memory of the rest of the DM by default — the model
  uses `searchSlack` (`in:@user`) to pull earlier DM history on purpose.

### Sandbox / E2B — lazy, and PERSISTENT PER THREAD
- Config in `packages/sandbox/src/config.ts`. The E2B sandbox is the execution
  backend for the `bash`/file tools and the host tools that opt into it
  (`browser`, `deploySite`, `getFile`, `uploadFile`).
- **Lazy** (`packages/sandbox/src/lazy-sandbox.ts`, `LazySandbox`): the real
  `Sandbox.create` is deferred until a tool actually touches it, so **chat-only
  turns cost zero E2B**.
- **Persistent per thread (July 2026).** `destroy()` now **pauses** rather than
  kills, and the thread's `sandbox_id` is remembered in the new
  **`thread_sandboxes`** table; the next turn in that thread calls
  `Sandbox.connect(id)` (which auto-resumes a paused sandbox) and gets the same
  filesystem back — files written, packages installed, data downloaded. Verified
  end-to-end (write in turn 1 → read in turn 2, ~450ms resume; a different
  thread cannot see it). This is what makes a **`bash` recurring reminder**
  useful: kyto writes and tests a script in the thread, then schedules the
  reminder to run it. `prompts/sandbox.ts` tells the model so.
  - Persistence is opt-in via the injected **`SandboxStore`** (`load`/`save`/
    `clear`) — `packages/sandbox` stays free of a DB dependency. The bot's
    implementation is `lib/sandbox/store.ts` (`threadSandboxStore`). A
    `LazySandbox` built WITHOUT a store is still ephemeral (killed on destroy) —
    that's what the **subagent** uses.
  - **NOTE: this was never a regression.** It is a NEW feature. The pre-rewrite
    `lazy-session.ts` was also ephemeral ("we never persist a session, the
    workspace is always empty at start"), and nothing ever wrote the old
    `sandbox_sessions` table — that table is orphaned scaffolding from an
    abandoned `feat(persistence)` attempt and is deliberately NOT reused.
  - **A thread, not a "conversation."** Every message roots its own thread
    (including a top-level DM), so a new top-level DM gets a **new** sandbox.
    Persistence is within one Slack thread.
  - **Two things are fixed at CREATE time and therefore stale on a resumed
    sandbox**: the `network` egress rules (which broker the real `GH_TOKEN` —
    see the `gh` note) and the create-time `envs`. Rotating `GH_TOKEN` only
    takes effect on a thread's next fresh sandbox. Per-command env IS re-sent on
    every `run()`, so the short-lived per-turn Slack proxy token stays current.
  - **A thread's sandbox is one mutable machine**, and both a live turn and a
    `bash`/`agent` reminder reach for it. `acquireThreadSandbox`/
    `withThreadSandbox` (`lib/sandbox/store.ts`) serialize them, so a reminder
    can't pause the sandbox out from under a running command. A turn holds the
    lock for its whole duration (bounded by `AGENT_ATTEMPT_TIMEOUT_MS`).
  - **A paused sandbox costs storage**, so `startSandboxReaper()` (hourly,
    `index.ts`) kills anything untouched for **7 days** (`SANDBOX_TTL_MS`) and
    forgets the row. `killSandbox()` is exported from `@repo/sandbox` for this.
  - `runOnce(command, apiKey)` (`packages/sandbox/src/run-once.ts`) spins up a
    throwaway sandbox for callers with no thread to reuse (a legacy `bash`
    reminder whose row predates `thread_id`).
- **Memory = the Slack thread.** `buildPrompt` (`lib/agent/prompt.ts`) still
  feeds the **whole thread** (`slack.fetchMessages`, capped) as context; no
  model session is persisted. Message contents are still never stored, so kyto
  remains "live processing without storing message contents" for the Slack
  Scraping policy — the sandbox persists a *filesystem*, not a transcript.
  `langfuse` tracing stays disabled for the same reason (it would export message
  content); env keys remain but unused.
