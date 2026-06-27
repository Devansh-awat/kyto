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

- **Pushing / opening a PR: still ask first.** Auto-commit/restart/sync are
  local-and-Slack only. Anything that publishes to **GitHub** (`git push`,
  `gh pr create`) requires explicit user confirmation.

### AI tools
- Agent tools live in `apps/bot/src/lib/ai/tools/` and are registered in
  `apps/bot/src/lib/ai/toolset.ts`. Raw Slack Web API access is via
  `slack.webClient.apiCall(method, args)` from `@/lib/chat`; error helpers are
  `errorMessage()`/`toLogError()` from `@/lib/utils/error`.
- Fork-added tools: `canvasRead/Write/List/Delete`, `pinMessage`, `unpinMessage`,
  `bookmarkLink`, `createChannel`, `setChannelTopic`, `poll`, `getPermalink`,
  `fetchUrl`, `deploySite`, `removeSite`, `skip`, `sendAsUser`, `editAsUser`.
- Slack scopes are declared in `slack-manifest.json` — update it when a tool
  needs a new scope.

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
- `deploySite`/`removeSite` publish prebuilt static sites at
  `https://<host>/kytosites/<name>/`. Code in `apps/bot/src/lib/sites/`. The
  host NEVER executes site code — building/testing happen in the E2B sandbox;
  only static output is copied out (`resolveWithin` path containment).
- Server starts from `apps/bot/src/index.ts` (`startSitesServer`), binds
  `SITES_PORT` (default 443). Serves **plain HTTP by default** because it sits
  behind Nest's TLS-terminating proxy (serving HTTPS there → 502). Set
  `SITES_TLS=true` for a self-signed HTTPS cert (standalone/local).
  `SITES_PUBLIC_HOST` builds the public URL (always `https://`). Config:
  `SITES_ENABLED`, `SITES_PORT`, `SITES_TLS`, `SITES_ROOT`, `SITES_PUBLIC_HOST`.

### Manifest sync
- `bun run sync:manifest` (apps/bot) pushes `slack-manifest.json` to the Slack
  app config via `apps.manifest.update`. Needs a Slack **app configuration
  token** (not the bot/user token): `SLACK_APP_ID`, `SLACK_CONFIG_ACCESS_TOKEN`,
  and optional `SLACK_CONFIG_REFRESH_TOKEN` (auto-rotates the short-lived access
  token first). Scope changes require reinstalling the app.

### Models / LLM model router + fallback
- **The main query always runs on a PAID model chosen per-request by an LLM
  router.** `MODEL_CATALOG` in `packages/ai/src/providers/pi.ts` lists ~10 paid
  HackClub models (fast → frontier) each with a capability `blurb` (sourced from
  the proxy's official `/models` descriptions) plus a cost hint. To change the
  lineup or descriptions, edit `MODEL_CATALOG`.
- **Router** (`apps/bot/src/lib/ai/router.ts`): `pickModel({ text, exclude })`
  sends the catalog blurbs + the user message to a cheap, fast NON-reasoning
  model (`mistralai/mistral-small-3.2-24b-instruct`, ~$0.07/1M, ~0.5s) and
  returns the chosen catalog id. Reasoning models are unusable here — their
  hidden thinking eats the tiny token budget and yields empty content. On any
  failure (or no `HACKCLUB_API_KEY`) it falls back to the cheapest non-excluded
  catalog model (`DEFAULT_MODEL` = `deepseek/deepseek-v4-pro`), never throwing.
- **Fallback on failure** (`agent/index.ts`): when a chosen model errors/empties,
  it's added to an `exclude` list and the router is re-asked for a different
  model. Once the whole catalog is exhausted, it falls through to the
  `deepFallbackAttempts` deep backup (baishui → Gemini) so the bot still answers
  if HackClub is down.
- The chosen model (and any fallback model) is surfaced as a **`Model` task in
  the thinking section** — never announced in the reply text. Useful for seeing
  which model actually served a turn.
- `chatAttempts`/`attemptsFor`/`PREMIUM_MODEL` remain exported (used by
  `compaction.ts`, which always runs on `chatAttempts[0]`).
- Fallback advances on **any** error AND on an **empty completion** — a model
  that finishes producing nothing (e.g. a HackClub 504 swallowed into an empty
  stream) is treated as a failed attempt, not a silent success. A deliberate
  `skip` is NOT an empty completion (it counts as a handled turn), and any
  provider placeholder text like `(Empty response: ...)` is dropped before it
  reaches Slack (`agent/index.ts`, `ai/stream/index.ts`).
- No **Stop button** is posted during a turn (removed from `postControls` flow).
- `glm-4.7` is omitted from HackClub (persistent 504); `glm-5.2` 504s
  intermittently there but degrades via the empty-completion fallback, and is
  also reachable via baishui (`glm5.2-normal`).

### Sandbox / E2B
- Config in `packages/sandbox/src/config.ts`. Only sandbox/code-execution work
  bills E2B; the Slack tools above are free HTTP calls.
