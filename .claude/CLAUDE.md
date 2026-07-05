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

### AI tools
- Agent tools live in `apps/bot/src/lib/ai/tools/` and are registered in
  `apps/bot/src/lib/ai/toolset.ts`. Raw Slack Web API access is via
  `slack.webClient.apiCall(method, args)` from `@/lib/chat`; error helpers are
  `errorMessage()`/`toLogError()` from `@/lib/utils/error`.
- Fork-added tools: `canvasRead/Write/List/Delete`, `pinMessage`, `unpinMessage`,
  `bookmarkLink`, `createChannel`, `setChannelTopic`, `poll`, `getPermalink`,
  `fetchUrl`, `deploySite`, `removeSite`, `skip`, `sendAsUser`, `editAsUser`,
  `browse`, `sendEmail`/`checkInbox`/`replyEmail`, `joinThread`,
  `scheduleRecurringReminder`/`listReminders`/`cancelReminder`/
  `pauseReminder`/`resumeReminder`, `unreact` (removeReaction), `wait`,
  `deleteFile`/`fileStat`, `runBackgroundProcess`/`getProcessOutput`/
  `killProcess`, `runSubagent`.
- **`unreact`** (`tools/react.ts`): mirrors `react` but calls
  `thread.adapter.removeReaction`.
- **`wait`** (`tools/wait.ts`): a mid-turn pause — sleeps up to 4 minutes then
  returns control to the model, for spacing out steps or riding out a brief
  external delay. Capped well under `ATTEMPT_TIMEOUT_MS` (10 min default) so it
  can never itself trip the per-attempt watchdog. For anything longer, use
  `scheduleReminder` instead — this does not survive past the current turn.
- **`deleteFile`/`fileStat`** (`tools/files.ts`): sandbox file ops. `SandboxContext`
  only exposes `readBinaryFile`/`writeBinaryFile`/`run` (no dedicated delete/stat
  API), so both shell out via `session.run` (`rm`/`stat`), same pattern as
  `browse.ts`/`deploy-site.ts`, with the same workspace-path containment check
  `uploadFile` uses.
- **Background process control** (`tools/background.ts`): `runBackgroundProcess`/
  `getProcessOutput`/`killProcess`. The harness's `ExecutionEnv.Shell.exec` is a
  single blocking call with no native detached-process concept, so this is a
  standard nohup-and-logfile trick on top of it (start detached, capture the
  pid, poll the logfile/pid liveness). Handles live in an in-memory `Map` closed
  over per-turn (`buildTools()` runs fresh each turn) — no persistence, and any
  still-running background process dies with the turn's sandbox.
- **`runSubagent`** (`tools/subagent.ts`): delegates a research task to a
  separate, lightweight tool loop so it doesn't clutter the main turn's own
  context. NOT the full Pi harness — a plain `generateText` call (like the old
  reminder-agent design) through HackClub's `openrouter/auto`, with a curated
  read-only toolset (`searchWeb`, `searchSlack`, `fetchUrl`, `getUser`,
  `getChannelInfo`, `readConversationHistory`, `listThreads`,
  `summarizeThread`) — no posting/reacting/acting, no sandbox. Capped at 8
  steps. Because it also targets `openrouter/auto`, it picks up the same
  request tuning as the main turn (resolved-model.ts's fetch patch keys off the
  request URL/model id, not the call site) — same cost bias, same
  `max_tokens` cap on HackClub.
- **Recurring reminders** (`tools/reminders.ts`, `lib/reminders/scheduler.ts`,
  `lib/reminders/agent.ts`, `@repo/db` schema/queries `reminders`): unlike the
  pre-existing one-time `scheduleReminder` (which uses Slack's native
  `chat.scheduleMessage` — a single future timestamp, no repeat support),
  recurring reminders are driven entirely by kyto's own process since Slack has
  no recurring-schedule API. `scheduleRecurringReminderTool` persists a row
  (`user_id`, `text`, `recurrence: 'interval'|'daily'|'weekly'`, plus the
  relevant `interval_seconds`/`time_of_day_minutes`/`weekday`, and
  `next_run_at`) to Postgres via Drizzle (`packages/db/src/schema/reminders.ts`
  — a new `patchedDependencies`-free table originally pushed directly with a
  one-off script since `drizzle-kit push` prompted for an interactive rename
  decision against the pre-existing `user_customizations`/`sandbox_sessions`
  tables in a non-TTY shell; later column additions here hit a **worse**
  problem — `drizzle-kit push` diffs the **entire** database, including tables
  it doesn't own (`chat_state_subscriptions`/`chat_state_cache`/
  `chat_state_lists`, owned by `@chat-adapter/state-pg`), and tried to **drop**
  all of them as "not in the Drizzle schema"; column additions are now applied
  with a one-off raw-SQL script (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`)
  instead of `db:push`, to avoid ever re-triggering that data-loss prompt).
  Four **kinds** (`kind: 'message'|'script'|'bash'|'agent'`, default `'message'`):
  - `'message'`: posts `text` verbatim (the original/only behavior before this
    was added).
  - `'script'`: fetches `url` each run (`fetchUrlText`, factored out of
    `tools/url.ts`'s `fetchUrlTool` so both share the same HTML-stripping/
    truncation logic) and posts its content, prefixed by `text` if given. Min
    interval **60s** — it's just an HTTP fetch, cheap to run often. This kind is
    deliberately dumb (raw fetch only, no logic) — for anything that needs real
    parsing/processing on a schedule, use `'bash'` instead.
  - `'bash'`: runs a shell `command` each fire in a **brand-new, throwaway E2B
    sandbox** (`lib/reminders/bash.ts`'s `runReminderBash`, backed by
    `packages/sandbox`'s new `runOnce` helper) and posts its **exact**
    stdout/stderr, fenced in a code block, prefixed by `text` if given. Unlike
    the harness's lazy per-turn sandbox session, this has no session/harness
    machinery at all — it's a one-shot `Sandbox.create` → `commands.run` →
    `sandbox.kill()` outside any turn, since the scheduler fires independently
    of any Pi turn. Output is truncated to 4000 chars. Min interval **300s (5
    minutes)** — spinning a real sandbox each run has real compute cost, above
    `'script'`'s bare HTTP fetch but well below `'agent'`'s LLM call.
  - `'agent'`: runs through the **SAME Pi harness** as a normal chat turn
    (`lib/reminders/agent.ts`, `runReminderAgent`) — full lazy sandbox, full
    tool set (search, canvas, pins, sites, the works), via `buildTools()` —
    but pinned to the owner's **own Gemini key** (`geminiAttempt('gemini-3.1-flash-lite')`,
    `packages/ai/src/providers/pi.ts`), never `openrouter/auto`/HackClub, so an
    unattended job's cost stays predictable regardless of what the reminder
    text asks for. Upgraded from a bare `generateText` + single `fetchUrl`
    tool (the original minimal design) specifically so it can genuinely "do
    all kyto can." Since there's no live Slack event to build a `Thread`/
    `Message` from, `runReminderAgent` mints one: a synthetic `Message` (`new
    Message({...})`, the `chat` SDK class has a public constructor) plus a
    real `Thread` — `bot.openDM(reminder.userId)` for the default DM case, or
    a small marker post to `bot.channel(channelId)` (to get a `threadId`) then
    `bot.thread(...)` for a channel-targeted one. Runs via `agent.generate()`
    (non-streaming — no live user watching a "thinking" card), and the
    scheduler posts whatever final text it returns, same as before. Caveat:
    `searchSlack` needs a live per-event Slack search `action_token`, which a
    scheduled fire doesn't have — the system prompt and tool docs tell the
    model to prefer `searchWeb` instead. Min interval **3600s (1 hour)**
    unchanged — a real model call each run (plus now, potentially, real
    sandbox/tool cost), so the floor stays high to keep unattended cost
    predictable.
  Every recurring reminder, regardless of kind, now **auto-cancels after
  `MAX_RECURRING_RUNS` (20) fires** (`queries/reminders.ts`) — `advanceReminder`
  increments `run_count` and flips `active: false` instead of computing a next
  run once the cap is hit, and the final post appends a note that this was the
  last run. This replaced the old "recurring means forever" behavior — a
  forgotten reminder no longer runs unattended indefinitely.
  **Posting target**: reminders can now post to an explicit `channelId` (Slack
  channel id) instead of only the creating user's DM — `scheduleRecurringReminderTool`
  requires kyto to **already be a member** of that channel (checked via
  `conversations.info`'s `is_member` at schedule time) and **deliberately never
  auto-joins** for this, unlike the pins/canvas tools' auto-join-on-`not_in_channel`
  pattern — an unattended background job shouldn't be the thing that joins a new
  channel. Omit `channelId` to keep the original DM-the-creator behavior.
  `startReminderScheduler` (`index.ts`) runs a `setInterval` (30s) on the
  always-on systemd process that polls `reminders WHERE active AND
  next_run_at <= now()`, builds the message per-kind, resolves the target
  (`bot.channel(...)` or `bot.openDM(...)`), posts, then calls
  `advanceReminder`. `listReminders`/`cancelReminder`/`pauseReminder`/
  `resumeReminder` let the model manage a user's own reminders (all scoped by
  `user_id`, so a user can only touch their own; `listReminders` now also
  surfaces `kind`, `channelId`, `url`, `paused`, and `runsRemaining`). This
  durable state is a deliberate exception to the "no persistence" policy
  elsewhere (turns/sandbox) — a reminder's entire purpose is to outlive the
  turn that created it, same precedent as site hosting and the opt-in
  allowlist.
  **Pause/resume** (`paused` column, `packages/db/src/schema/reminders.ts` +
  `queries/reminders.ts`, added via the same one-off raw-SQL `ADD COLUMN IF
  NOT EXISTS` pattern as above — never `db:push`, same data-loss risk):
  distinct from `active` (cancel deletes the row; the run-cap sets
  `active: false` permanently). `pauseReminder` only flips `paused: true` on
  an active, not-already-paused row; `getDueReminders` filters `paused =
  false` so the scheduler skips it. `resumeReminder` flips it back **and**
  recomputes `next_run_at` from *now* (not the original schedule anchor) so a
  long pause doesn't fire a backlog of missed runs.
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
- Slack scopes are declared in `slack-manifest.json` — update it when a tool
  needs a new scope.
- **Email** (`sendEmail`/`checkInbox`/`replyEmail`, `tools/email.ts`) runs
  **host-side** via the AgentMail JS SDK (`agentmail` npm) using
  `AGENTMAIL_API_KEY`. Registered only when that key is set (toolset.ts). It is
  NOT in the sandbox anymore (the key is no longer injected there).
- **Browser** (`browse`, `tools/browse.ts`) runs the preinstalled
  `agent-browser` CLI **inside the sandbox** (Chromium stays isolated off the
  host). It's a thin wrapper: pass agent-browser args in `command` (run
  `skills get core` first). Using it materializes the lazy sandbox. The old
  `agentmail`/`agent-browser` **Pi skills were removed** — kyto now loads **zero
  Pi skills** (any skill would force per-turn sandbox creation; see Sandbox/E2B).
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
  effect (see Manifest sync note) — **confirmed done**: `auth.test`'s
  `x-oauth-scopes` header on the live bot token includes `search:read.im`,
  `search:read.mpim`, and `search:read.private`.
- **DM search: don't combine `to:` with a DM lookup.** `to:@user` only means
  "mentions this user" inside a **channel** search — it is not a DM-scoping
  modifier and doesn't identify a DM conversation. A query like `from:@bot
  to:@me` to find a DM with a bot reliably returns 0 results (observed: kyto
  failed to find a real DM from another bot this way) even though the bot
  token has the right `search:read.im` scope and the messages exist — the
  query itself was malformed, not a permissions/data problem. The fix is
  the correct modifier: `in:@user` **alone**, where `@user` is the *other*
  party in the DM (never the requesting user, never paired with `to:`); add
  `from:@user` only to further filter to messages sent by that party within
  the DM. Both the tool description (`tools/search-slack.ts`) and the core
  prompt (`packages/ai/src/prompts/core.ts`) now spell this out explicitly and
  tell the model to retry with `in:@user` alone before concluding a DM's
  content doesn't exist.
- **DM search: a bare user id (no `@`) after `in:`/`from:`/`to:` is silently
  ignored, not an error.** Even after the `to:`-vs-`in:` fix above, a DM lookup
  still failed: the model wrote `in:U09ASUK57K8` (the correct modifier, but the
  raw id with no leading `@`) and got 0 results even though the DM existed —
  Slack's search parser doesn't recognize a bare id as a user reference at all,
  so it silently drops the modifier rather than erroring, and the empty result
  looks identical to "no messages exist." Fixed defensively at the **code**
  level rather than relying on the model to remember the `@`:
  `normalizeSearchQuery` in `tools/search-slack.ts` regex-repairs
  `(in|from|to):<bare U/W-id>` to `(in|from|to):@<id>` before the query ever
  reaches `assistant.search.context` (logged at debug when it fires). The tool
  description and core prompt also spell out the `@`-required rule with a
  concrete example, as defense in depth for other malformed forms the regex
  doesn't catch.
- **Root cause, finally confirmed via Slack's own docs**: DM search kept
  failing even with a correctly-formed `in:@<raw id>` query on a DM confirmed
  (by the owner, checking Slack directly) to have real history — ruling out
  both the `to:`-vs-`in:` bug and the missing-`@` bug above. Two real,
  doc-confirmed issues, both now fixed in `tools/search-slack.ts`:
  1. **User references need Slack's angle-bracket mention form**, `<@U12345>`
     — a bare `@U12345` (no brackets) is silently ignored as if the modifier
     were never given, same failure mode as the missing-`@` case (no error,
     just 0 results). `normalizeSearchQuery`'s `USER_REF_MODIFIER` regex now
     rewrites any of `in:U123`/`in:@U123`/`in:<@U123>` to the canonical
     `in:<@U123>` (idempotent — already-correct queries pass through
     unchanged) before the query reaches `assistant.search.context`.
  2. **`assistant.search.context` takes a `channel_types` parameter that we
     were never passing at all.** Per the docs this independently controls
     which conversation types (`public_channel`/`private_channel`/`mpim`/`im`)
     the search covers, separately from `content_types` (which only
     scopes messages/files/channels/users). Omitting it appears to default to
     something that excludes DMs, so a DM search could return 0 results
     regardless of query correctness. The call now always passes
     `channel_types: 'public_channel,private_channel,mpim,im'` so the
     `search:read.im`/`.mpim`/`.private` bot scopes actually get used for
     what they're granted for.
  The earlier "retry with resolved username" workaround
  (`queryWithResolvedHandles`) was chasing the wrong hypothesis and has been
  **removed** now that the real cause is confirmed — no more speculative
  retries needed here.
- **`in:@user` still returned 0 for a real DM even with correct bracket format
  AND `channel_types` fixed.** Meanwhile `from:<@ownId>` (searching the
  requesting user's OWN messages) succeeded and returned real results — so the
  bracket format and scopes are confirmed working, but specifically targeting
  a DM by participant via `in:` was not. `in:` is documented as targeting a
  channel/conversation OBJECT (`in:#channel`, `in:<#C0123>`), not "the DM with
  this person" — Slack's own docs instead show `with:<@U12345>` as the
  modifier for "messages that involve a user," which is the semantically
  correct one for a DM lookup. `withModifierFallback` in `tools/search-slack.ts`
  now retries an `in:<@user>` search as `with:<@user>` if the first attempt
  comes back empty, and the tool description/core prompt now recommend
  `with:@user` over `in:@user` for DM lookups directly, rather than relying
  solely on the fallback.
- **Conclusion (as far as this can be root-caused without Slack support):
  private 1:1/group DM search is admin-gated, not a query bug, and kyto
  cannot fix this itself.** `with:@tanjim` (correct modifier, correct bracket
  format, `channel_types` including `im`) DID return real results — but only
  from a **public** channel (`#botthissite`) where both users had posted; the
  actual private DM content between them never surfaced, no error either
  time. Slack's Real-time Search API docs state private-channel/DM/MPDM
  search additionally requires **user-level consent that can be individually
  revoked**, separate from the app's declared `search:read.*` scopes — i.e.
  scopes being granted at the app-install level doesn't guarantee the
  requesting user has been granted (or the workspace admin has approved) the
  specific private-search consent this feature needs. The owner (Devansh)
  checked every tab of the app's own Slack UI and found no such consent
  prompt/toggle for kyto, and he is **not** a workspace admin/owner on Hack
  Club's Slack (`is_admin`/`is_owner`: false via `users.info`) — so if this is
  gated behind admin-level app approval (common on Enterprise Grid workspaces,
  especially for a scope as sensitive as `search:read.im` on a personal/
  custom bot), he cannot unlock it himself; only a Hack Club Slack admin
  could. Decision: **accept this as a platform limitation** rather than keep
  chasing it in code — `tools/search-slack.ts`'s description and the core
  prompt now say plainly that DM search is best-effort and a DM search
  returning 0 (or only public-channel hits) must be reported as inconclusive,
  never as "no history exists." Revisit only if Hack Club admins are asked
  and confirm/deny an app-approval restriction, or if Slack support clarifies
  the actual authorization model for this API.
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
- `sendAsUser` defaults to replying **in the active thread** when called from
  one — this surprised the owner once ("post in the channel" from inside a
  thread still landed in the thread, and passing a `channelId` equal to the
  *current* channel didn't change that, since only a genuinely different
  channel id triggered top-level posting). Fixed by adding an explicit
  `topLevel: boolean` param (`tools/send-as-user.ts`): `postTopLevel =
  crossChannel || topLevel` now decides whether `thread_ts` is omitted from
  `chat.postMessage`, so the model can post at the top level of the *current*
  channel (not just a different one) when the owner asks for that.

### Static site hosting
- `deploySite`/`removeSite` publish prebuilt static sites at the **host root**:
  `https://<host>/<name>/` (default host `kyto.devansh.hackclub.app`). Code in
  `apps/bot/src/lib/sites/`. The host NEVER executes site code — building/testing
  happen in the E2B sandbox; only static output is copied out (`resolveWithin`
  path containment). The on-disk store is still `SITES_ROOT` (`/var/kytosites`).
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
- **The main query runs on OpenRouter's own auto-router via HackClub**
  (`ROUTER_MODEL = 'openrouter/auto'` in `packages/ai/src/providers/pi.ts`). The
  HackClub proxy is OpenRouter-compatible, so sending model id `openrouter/auto`
  hands routing to OpenRouter, which picks the best underlying model per request
  (e.g. it resolved to `openai/gpt-5.5` in testing). This replaced the old
  per-request router-LLM hop (`pickModel`/`buildRoutingContext`, deleted) and the
  `meta-llama/llama-3.3-70b-instruct` fast tier, which was unreliable for tool
  use (hallucinated tool names, wrong-bot/persona confusion, stray "battles").
- **Fallback on failure** (`agent/index.ts`, `routeNextAttempt`): `openrouter/auto`
  is attempt 0. On any error or empty completion it (1) retries the **exact model
  auto resolved to**, pinned via HackClub (auto's failure is often transient/an
  empty completion), then (2) walks the `LEADERBOARD_FALLBACK` list (`pi.ts`)
  **UP** from that model toward the best (closest-better first), then **DOWN**
  toward the weakest. `LEADERBOARD_FALLBACK` is the owner's arena leaderboard,
  best→worst, restricted to reachable models: the strong tier on HackClub
  (opus-4.8/4.7/4.6, gpt-5.5/5.4, glm-5.2/5.1, sonnet-4.6), then the rest of the
  leaderboard appended in rank order (kimi-k2.7-code, gemini-3.1-pro-preview,
  gemini-3.5-flash, deepseek-v4-flash, kimi-k2.6, minimax-m3, deepseek-v4-pro,
  qwen3.6-plus, grok-4.3, grok-build-0.1, gemini-3-flash-preview, minimax-m2.7,
  nemotron-3-ultra-550b-a55b — all verified present on
  `ai.hackclub.com/proxy/v1/models`). Claude Fable 5 is also reachable there now
  (`anthropic/claude-fable-5`) but deliberately excluded — ~2x opus-4.8's
  per-token cost, not worth it against the daily HackClub spend cap. Both
  gemini-3.1-pro-preview and gemini-3.5-flash were previously excluded here too
  for a confirmed 100%-empty-response failure, then re-added at the owner's
  request (see below) — re-remove if the failure recurs.
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
- **HackClub spend-limit failover → straight to Gemini**: if a HackClub call
  returns the daily-spend 429 (`SPEND_LIMIT_PATTERN`, surfaced via
  `renderStream`'s `onError`), `routeNextAttempt` sets `hackclubBudgetExhausted`.
  The whole HackClub budget is **shared**, so once the first call 429s every other
  HackClub rung 429s the same way (they just burn attempts at ~4ms each). So the
  flag flips `buildFallbackQueue` to **skip all HackClub rungs and go straight to
  the owner's Gemini key** (`geminiAttempts`, separate quota, reliable, cheap),
  then any other non-HackClub rung (baishui, if re-enabled). The pinned
  resolved-model retry is also skipped on spend-limit (it's a HackClub call).
  (This replaced the older cheapest-first-HackClub-retry approach — the
  pessimistic-limit "a cheap rung might still fit" recovery wasn't worth the
  wasted 429 attempts once the Gemini key exists as a clean, cheap escape.)
- **Fetch interceptor** (`apps/bot/src/lib/agent/resolved-model.ts`, installed in
  `index.ts`): Pi makes model calls through the process-global `fetch` (undici),
  so we patch it to tune the request and read the response:
  - **Tune the auto-router**: inject the `auto-router` plugin into the
    `openrouter/auto` request body with `cost_quality_tradeoff` (0 = best/dearest,
    7 = OpenRouter's own default, 10 = cheapest). Two tiers, both biased well past
    the default toward cost, chosen by the owner: **9** for a normal chat turn
    (`COST_QUALITY_TRADEOFF`), **10** (cheapest) when the call originates from a
    recurring-reminder job (`RECURRING_JOB_COST_QUALITY_TRADEOFF`) — the latter
    is picked via `runAsRecurringJob()`'s `AsyncLocalStorage` flag
    (`recurringJobStore`), read by `tuneCompletionsBody` at request time. Note the
    recurring `'agent'` reminder kind is pinned to a direct Gemini attempt (see
    reminders section above) so it doesn't normally reach `openrouter/auto` at
    all today — the flag exists for if/when a HackClub fallback is added to that
    path, and is exercised right now by `runSubagent` (`tools/subagent.ts`, which
    also targets `openrouter/auto` and picks up whichever tier is active for its
    caller). An **`allowed_models`** allowlist
    of **exact slugs** (the field is `allowed_models` — the older `model_patterns`
    name is silently ignored by the proxy; not globs, so no
    `-nano`/`-mini`/`-flash-lite`/`-fast` or `claude-fable-5` leakage):
    claude-opus-4.6/4.7/4.8, claude-sonnet-5, claude-sonnet-4.6, gpt-5.4/5.5, glm-5.1/5.2,
    **gemini-3.1-flash-lite** (the cheap rung — added so auto
    can route simple/casual turns off the premium tier, the main cost blowup, and
    as the signal for handing a turn to the owner's Gemini key), plus
    `gemini-3.1-pro-preview` and `gemini-3.5-flash` (re-added 2026-07-02 at the
    owner's request). Both were previously removed: `gemini-3.1-pro-preview`
    once ended a turn right after its tool calls without ever writing a reply
    (the empty-response guard counted that as a failed attempt and burned the
    fallback chain), and `gemini-3.5-flash` returned an **empty response on
    100% of observed attempts** (22/22 direct via `geminiAttempts`/
    `GEMINI_MODELS` in `pi.ts`, 10/10 via the auto-router's
    `google/gemini-3.5-flash` slug in `LEADERBOARD_FALLBACK`) — the owner's
    Google AI Studio dashboard showed **zero requests metered** against it
    despite these attempts, meaning the calls were rejected before reaching
    generation (likely not enabled for a free-tier key at the time), not that
    the model burned its output budget on thinking; it also only carries a 20
    RPD free-tier quota vs. 3.1-flash-lite's 500 RPD. Because of that dashboard
    signal, `gemini-3.5-flash` was kept OUT of `GEMINI_MODELS` (`pi.ts`, the
    direct-key path) when re-adding it here and to `LEADERBOARD_FALLBACK` — the
    HackClub-proxied call is a different request path and may not be tier-gated
    the same way; `gemini-3.1-pro-preview` was re-added to all three (it's not
    known to have that dashboard issue). If the empty-response failure recurs
    on either model, watch `[stream] tally` in the logs (0 textDeltas/
    reasoningParts despite tool activity) and re-remove from `ALLOWED_MODELS`
    (here) and `LEADERBOARD_FALLBACK` (`pi.ts`), plus `GEMINI_MODELS` (`pi.ts`)
    for `gemini-3.1-pro-preview`. The
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
- The model is surfaced as a **`Thinking` task in the thinking section** (title
  `Thinking`, or `Thinking · fallback` on retries — renamed from `Model` so the
  collapsed row reads as an activity status: the model is working). The concrete
  model is shown **only on completion** as the task `output` (`provider · model
  → <resolved>`); the `in_progress` emit carries **no `output`** — setting it on
  both states made the finished row render the `provider · model` line **twice**
  (the "model name shown twice" bug). Reasoning tokens the model streams render as
  a **separate `Reasoning` task** (`stream/index.ts`) so the two don't collide.
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
  counts as **handled** iff it produced reply text, a deliberate `skip`, OR tool
  activity **that ended on a clean `stop`** finish. The clean-stop qualifier is
  the fix for the **"stops mid-task" bug**: a turn could run tools (e.g. a few
  web searches) and then the synthesis step came back **empty/truncated — no text
  and no finish reason** (a spend-limit 429 or 504 swallowed into an empty
  continuation), yet `producedToolActivity` alone marked it handled, so the turn
  ended **silently with no answer**. Now `renderStream`'s `onFinish` reports each
  finishReason; the agent tracks a per-attempt `sawCleanStop` (true only on
  `stop`). Tool activity counts as handled ONLY with a clean stop (the model ran
  tools then deliberately finished — the original anti-cascade case, just no
  narration); tool activity that ends WITHOUT a clean stop falls back to another
  model so the user actually gets an answer. A truly empty completion (no text,
  skip, or tools) also falls back. Tracked via `onToolActivity` →
  `producedToolActivity`, `onFinish` → `sawCleanStop`, `onSkip` → `skipped`. Any
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
  (`browse` passes `abortSignal` into `session.run`) get their hung command
  killed, unblocking Pi. Without this a turn could hang forever (observed: a
  website-build turn froze after an "On it…" preamble + a browser open that never
  returned). Other sandbox tools (`deploySite`, `getFile`, `uploadFile`) do not
  yet forward the signal — extend them the same way if they're seen to hang.
- `glm-4.7` is omitted from HackClub (persistent 504); `glm-5.2` 504s
  intermittently there but degrades via the empty-completion fallback (baishui is
  disabled, so no `glm5.2-normal` backstop).

### Identity & opt-in gating
- **Kyto is closed-source and must not claim otherwise.** The system prompt
  (`packages/ai/src/prompts/slack.ts`, end of `slackPrompt`) previously told the
  model "Kyto is built on open-source code available at
  https://github.com/imdevarsh/gorkie-slack" — that repo is the private fork's
  own source, not something to hand out, and saying "open source" was simply
  wrong for a private app. Replaced with a line stating Kyto is closed-source
  private software, started as a fork of the open-source gorkie project, with
  no public repo link to share. If asked for source/repo access, the model
  should say so rather than pointing at (or paraphrasing) a GitHub URL.
- **Reply footer: token count + generation speed.** Every reply that produced
  text now ends with a small italic footer, e.g. `_12,345 tok · ⚡42.3 tok/s_`
  (mirrors gorkie's dev-bot output). Added in `agent/index.ts`'s
  `formatUsageFooter`, called right after the per-attempt stream loop when
  `producedText` is true, appended into the same `reply` buffer that gets
  flushed to Slack. Sourced entirely from the AI SDK's own already-computed
  totals — `result.usage.totalTokens` and the last entry of `result.steps`'
  `performance.effectiveOutputTokensPerSecond` — no manual turn-start
  timestamp needed. `Agent` (the `HarnessAgent` instance type) is now exported
  from `packages/ai/src/index.ts` so `agent/index.ts` can type the result of
  `agent.stream(...)` without reaching into `@ai-sdk/harness` internals.
  Skipped (no footer) on a deliberate `skip` or a tool-only turn with no text.
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

### DM threading (patched @chat-adapter/slack)
- **Every DM reply is now threaded, mirroring channel behavior.** The upstream
  `@chat-adapter/slack` (v4.30.0) special-cased DMs so a top-level DM message
  (`channel_type: "im"`, no `thread_ts`) got an **empty** threadTs — unlike
  channels, which fall back to the message's own `ts`. That empty threadTs broke
  two things: (1) Slack's native streaming API (`StreamingPlan` -> `adapter
  .stream`) throws `ValidationError: Slack streaming requires a valid thread
  context` on an empty threadTs, so **every DM turn failed** ("oops, something
  went wrong") until this was patched — the "thinking" task-card UI is exactly
  what needs that native stream; (2) `buildPrompt`'s `slack.fetchMessages
  (thread.id)` had no threadTs to scope to, so it silently fell back to fetching
  the **whole DM history** as context on every turn.
- Fixed via `bun patch` (`patches/@chat-adapter%2Fslack@4.30.0.patch`,
  `package.json`'s `patchedDependencies`): removed the DM special-case in
  `handleMessageEvent` so `threadTs = event.thread_ts || event.ts` unconditionally,
  same as channels. Effects: a top-level DM message now starts (and kyto replies
  within) its own thread, not the main DM timeline; a reply-in-thread from the
  user continues that same thread (still dispatched to `onDirectMessage` per
  chat-sdk's routing — DMs always go there over `onSubscribedMessage`, so no
  `bot.ts` change was needed); and `buildPrompt` now scopes context to just that
  thread, so **kyto has no memory of the rest of the DM by default** — the model
  must use `searchSlack` (`in:@user`) to pull in earlier DM history on purpose.
  This patch must survive `bun install`/lockfile updates (it's declared in
  `package.json`), but re-verify it after any `@chat-adapter/slack` version bump
  (`bun patch @chat-adapter/slack` again if the line shifts).
- `apps/bot/src/lib/agent/index.ts`'s pre-`StreamingPlan` threadTs check (added
  before this patch existed, to drain the turn without native streaming when
  threadTs was empty) is kept as a defensive fallback for any other path that
  might produce a threadId with no threadTs, but should no longer trigger in
  practice for DMs.

### Sandbox / E2B — lazy + ephemeral, no persistence
- Config in `packages/sandbox/src/config.ts`. **Nothing is stored between turns.**
  Pi runs in-process on the host (no bridge); the E2B sandbox is only the
  execution backend for Pi's builtin `bash`/file tools and the host tools that
  opt into it (`browse`, `deploySite`, `getFile`, `uploadFile`).
- **Memory = the Slack thread.** Each turn opens a **fresh** Pi session (no
  resume) and `buildPrompt` (`lib/agent/prompt.ts`) feeds the **whole thread**
  (`slack.fetchMessages`, capped) as context. No session is persisted: the DB
  `sandbox_sessions` table and the in-sandbox `.pi-sessions` file are no longer
  written. (`!compact` and the per-thread DB session were removed.)
- **Lazy sandbox** (`packages/sandbox/src/lazy-session.ts`,
  `LazyE2BNetworkSandboxSession`): `createSession` hands the harness a session
  that defers the real `Sandbox.create` until a tool actually needs it, so
  **chat-only turns cost zero E2B**. The harness/Pi run a tiny fixed bootstrap on
  the sandbox at start (`mkdir -p <workdir>` + one workspace `find`; a `printf
  $HOME` only with Pi skills — we load none); the lazy session **fakes** those
  (the never-persisted workspace is always empty) and materializes on the first
  real file/exec op, replaying the recorded `mkdir`s. **This couples to harness/
  Pi bootstrap command shapes** — re-check on `@ai-sdk/harness*` upgrades; if a
  faked command changes, it degrades to "sandbox every turn" (correct, not lazy).
- **Ephemeral lifecycle:** the session is `destroy()`ed at turn end (kills the
  sandbox iff it was materialized; chat turns never created one). Never paused,
  never resumed, no DB row, no snapshot — so no paused-sandbox accumulation.
- This makes kyto "live processing without storing message contents" for the
  Slack Scraping policy. `langfuse` tracing is disabled for the same reason
  (it would export message content); env keys remain but unused.
