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
3. **Restart the bot** so the running process picks up the change. There is no
   process manager: the bot runs as a single `bun run src/index.ts` process.
   Restart with: `pkill -f 'bun run src/index.ts'` then relaunch in the
   background with `bun run start:bot` from the repo root. Confirm it came back
   up (check the process / startup logs).
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
  `browse`, `sendEmail`/`checkInbox`/`replyEmail`.
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
  (opus-4.8/4.7/4.6, gpt-5.5/5.4, glm-5.2/5.1, sonnet-4.6, gemini-3.5-flash) and
  the open tail on the **baishui proxy** (`jam06452.uk`: deepseek-v4-pro,
  kimi-k2.6, k2.7-code, deepseek-4-flash, m3) — the proxy rungs are skipped if
  `OPENROUTER_API_KEY`/`_BASE_URL` are unset. Fable 5 (rank #1) is omitted (no
  provider). The resolved slug is read off the per-turn model holder (`autoHolder`)
  captured during the auto attempt, so it pins/pivots even when auto failed. Each
  entry is tried at most once (tracked via `failedKeys`). `deepFallbackAttempts`
  is retained/exported for reference but no longer drives routing.
- **Fetch interceptor** (`apps/bot/src/lib/agent/resolved-model.ts`, installed in
  `index.ts`): Pi makes model calls through the process-global `fetch` (undici),
  so we patch it to tune the request and read the response:
  - **Tune the auto-router**: inject the `auto-router` plugin into the
    `openrouter/auto` request body with `cost_quality_tradeoff` (0 = best/dearest,
    7 = default, 10 = cheapest; we use **5**) and an **`allowed_models`** allowlist
    of **exact slugs** (the field is `allowed_models` — the older `model_patterns`
    name is silently ignored by the proxy; not globs, so no
    `-nano`/`-mini`/`-flash-lite`/`-fast` or `claude-fable-5` leakage):
    claude-opus-4.6/4.7/4.8, claude-sonnet-4.6, gpt-5.4/5.5, glm-5.1/5.2,
    gemini-3.5-flash (the owner's leaderboard top tier;
    `gemini-3.1-pro-preview` was removed after it ended a turn right after its
    tool calls without ever writing a reply — the empty-response guard counted
    that as a failed attempt and burned the fallback chain;
    the lower-ranked tail — deepseek-v4-pro/flash, kimi-k2.6/k2.7-code,
    minimax-m3, qwen3.6-plus — was dropped to keep routing on the stronger
    models). The interceptor strips a stale `Content-Length` when re-issuing the
    tuned (longer) body so the appended `plugins` isn't truncated. Verified
    honored by the HackClub proxy. Edit `COST_QUALITY_TRADEOFF`/`ALLOWED_MODELS`.
  - **Capture the resolved model**: the stream only exposes the *requested* id, so
    we read the concrete model OpenRouter resolved to from the `model` field of a
    clone of the response and stash it per-turn (`AsyncLocalStorage`).
- The model is surfaced as a **`Model` task in the thinking section** (never in
  the reply text), shown as `openrouter/auto → <resolved>`. The task is opened
  `in_progress` and completed once after streaming (same id) so it updates in
  place. `openrouter/auto` re-routes **per step**, so a turn can use several
  models; the task shows the **first** step's pick (every step is logged at info
  as `[router] resolved openrouter/auto model`).
- `MODEL_CATALOG`/`CATALOG_IDS` are retained for reference/diagnostics only (no
  longer drive routing). `chatAttempts`/`attemptsFor`/`PREMIUM_MODEL` remain
  exported for reference.
- Fallback advances on **any** error AND on an **empty completion** — a model
  that finishes producing nothing (e.g. a HackClub 504 swallowed into an empty
  stream) is treated as a failed attempt, not a silent success. A deliberate
  `skip` is NOT an empty completion (it counts as a handled turn), and any
  provider placeholder text like `(Empty response: ...)` is dropped before it
  reaches Slack (`agent/index.ts`, `ai/stream/index.ts`).
- **Hallucinated tool calls are hidden.** Weak models sometimes emit a tool call
  to a tool we never registered (observed: a mangled name `" analemma"`); the
  harness returns a `"Tool X not found"` tool-result and the model recovers next
  step. `renderStream` is passed `knownTools` and drops any tool-call (and its
  matching result/error) whose name isn't registered, so phantom calls never
  surface as activity tasks (`ai/stream/index.ts`).
- No **Stop button** is posted during a turn (removed from `postControls` flow).
- `glm-4.7` is omitted from HackClub (persistent 504); `glm-5.2` 504s
  intermittently there but degrades via the empty-completion fallback, and is
  also reachable via baishui (`glm5.2-normal`).

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
