# AI tools — per-tool detail

> **Tool families (2026-10-08):** the model sees `memory`, `reminders`, `canvas`, `sites`, `process`, `pins`, `reaction`, `followThread`, `embed`, `email` and `subagent` as single tools with an `action` field (`lib/ai/merge-tools.ts`, `TOOL_FAMILIES` maps each action to the verb named below). The verb names below are still the code's and the logs' names. `deleteFile`, `fileStat` and `summarizeThread` are deferred (unused in 436 turns).

> **Background jobs wake the thread (2026-10-08, owner's call):** `process` start, and a `bash` command auto-moved to the background after 60s, are watched host-side (`watchManaged` in `tools/background.ts`). Handles are PER THREAD (a later turn can read `bg-1`). Once the launching turn ends, a 20s poll keeps the sandbox awake (each poll resumes it; LazySandbox's late release pauses it ~2 min after polling stops). Finished and not yet seen by the model → a wake turn with the exit code and output tail. Still running 30 min after the turn → a "time's up" wake; `process` `output` on a running job re-arms another 30 min. Wakes chain at most 3 deep (`process-report-<n>-` ids); none for unattended runs or `!secret` turns.

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
- **`viewImage`** (`tools/view-image.ts`) lets the model look at a sandbox image (a screenshot, a generated/downloaded image). It buffers the bytes (`buildTools` → `drainImages`); `streamAttempt`'s `getFreshImages` is drained in `prepareStep`, appending the image as a **user message** for the next step (carries forward). `readFile` returns text — the sandbox prompt tells the model to `viewImage` instead of assuming it's blind. It also takes a **`question`**: with one, the image goes to the vision model (Gemini) and its ANSWER comes back in the tool result instead of the pixels being queued — that is how a text-only primary asks "what does this error say" / "transcribe the text", and a vision-capable primary gets it too, because a proper OCR read beats its own glance.
- The **primary is TEXT-ONLY** (deepseek-v4-flash), so `modelSupportsVision` routes any image through `describeImages` on the owner's Gemini key first. Both the main loop and the subagent get `getFreshImages`.

## Memory (private by default, promoted by the owner)

`saveMemory`/`fetchMemory`/`editMemory`/`deleteMemory` (core, `tools/memory.ts`;
`memories` table). Durable notes so a LATER thread reuses what this one worked
out. Each visible memory's `title` is injected as a `<memories>` block
(`RequestHints.memories`, rendered in `prompts/context.ts`); the model calls
`fetchMemory("<title>")` for the body only when relevant. `saveMemory` is
create-only (title unique PER AUTHOR; a clash tells the model to edit).

- **Four visibility states**, decided in one place — `visibleTo` in
  `packages/db/src/queries/memories.ts`: private to `createdBy`, `isGlobal`,
  `scopeKind: 'channel'` + `scopeId`, `scopeKind: 'group'` + `scopeId`. The
  scope arg is optional and every branch past "their own" needs an owner
  promotion, so a caller that forgets to pass it sees LESS, never more.
- **Only the owner promotes**, from the dashboard: `setMemoryGlobal` (which
  CLEARS any room scope — the two are alternatives) or `setMemoryScope`
  (`channel:C…` / `group:<id>`, empty box = back to private). The group ids are
  listed on the dashboard overview so there is something to paste.
- **Promotion transfers custody**, all three flavours: `canWrite` refuses the
  author once `isPromoted(row)` (`isGlobal || scopeKind !== null`). A promoted
  memory also survives a self-erase and is reported back by title.
- **The `<memories>` block renders even when EMPTY**, because the block is mostly
  the instruction to save and the person with no memories is who needs it.

## Channel groups (`channel_groups`, `lib/…` App Home)

A named set of channels, so one share covers several rooms. Anyone creates one;
its creator (and the bot owner) is the only one who may rename it, delete it, or
change its channels — checked at modal OPEN **and** SUBMIT, because the group id
round-trips through the client. `listGroupIdsForChannel(channelId)` is the hot
path (one indexed lookup, resolved once per turn in `buildTools` and reused by
both the memory scope and the MCP toolset). Deleting a group drops the MCP shares
pointing at it and demotes the memories scoped to it.

## Host-side tools and sandbox specifics

- **`gh`** (deferred, needs `GH_TOKEN` on host): GitHub CLI in the turn's sandbox. The real token is **on the HOST, behind kyto's GitHub proxy** (`lib/github-proxy/`, mounted on the sites Bun.serve) and is **never in the sandbox** — `echo $GH_TOKEN` prints nothing at all, and a bare `curl api.github.com` from the box is anonymous.
  - **How the routing works.** `githubProxyEnv` sets `GH_HOST` to the sites host plus `GH_ENTERPRISE_TOKEN` = the per-turn proxy secret, so `gh` treats kyto as GitHub Enterprise Server and calls `https://HOST/api/v3/…` and `https://HOST/api/graphql`. `githubProxyGitConfig` (run at every materialization, idempotent) points git at the same host with `url.<host>/.insteadOf` for all three github.com forms, plus a credential helper that echoes `$KYTO_GH_PROXY_TOKEN` — read from the env at call time, so a sandbox that outlives a turn always presents the CURRENT token. Both are re-sent per command; `openSandboxProxies` (`lib/sandbox/proxies.ts`) is the single place all three sandbox call sites get them from.
  - **What the proxy decides.** Reads pass. A write is classified (REST method+path, GraphQL `mutation`, git `git-receive-pack`), its repos extracted, and run through the SAME `guardGithubTargets` as the shell path — with `claim()` only on a 2xx. `gh` does its writes over GraphQL with an OPAQUE `repositoryId`, so the proxy resolves node ids to `nameWithOwner` via one cached `nodes(ids:)` query; an id it cannot resolve leaves the mutation with no target and is **refused**, so a GitHub outage blocks writes rather than waving them through. A write that names no repo at all (a gist, a follow, a raw mutation) is refused for the same reason.
  - **It answers ONLY requests carrying a live proxy token** and returns null otherwise, so a hosted site is never shadowed. The one exception is a git smart-HTTP request with no credentials — `?service=git-…-pack`, or a POST with an `application/x-git-…` content type — which gets a 401 `WWW-Authenticate` challenge, because git does not send credentials until it is asked and otherwise gave up with "repository not found".
  - The command-level `guardGithubCommand` in `gh`/`bash`/`codeMode`/`runBackgroundProcess` still runs and is NOT redundant: it refuses before anything executes and explains why in a sentence the model can act on. The proxy is what makes the gate unbypassable; the command guard is what makes it legible.
  - **kyto's GitHub identity is `kyto-agent`** (`GH_LOGIN`, verified against `api.github.com/user`). The tool description says so, because kyto used to read a PR opened by itself as "some other user called kyto-agent" and argue with the person who asked about it.
  - **Repo ownership gate** (`lib/github/guard.ts` + `lib/github/command.ts`, `github_repos` table): GitHub sees ONE account, so without this everyone who can talk to kyto inherits kyto's write access to every repo it touched — the reported abuse being "A has kyto make a repo, B has kyto close A's PR". `parseGithubCommand` classifies a command as read or write and extracts the repos (gh flags, `repos/o/n` API paths, github URLs, a bare `git push` resolved from the checkout's remote); a write to a **claimed** repo is refused unless the requester is the claimant, a named editor, or the bot owner. Reads are never gated. A claim is made **on success** for repos the command CREATES and for unclaimed repos in kyto's own namespace — never for third-party repos (first-toucher must not lock everyone out of a public repo). Same gate runs in `bash` and `codeMode` (both are shells; gating only `gh` would be theatre), and invocations are matched anywhere in the text so `sh -c "gh pr close …"` still hits it. `githubAccess` (deferred) lists claims, sets editors, and releases a claim.
- **Long tool output is clipped from BOTH ends, and SAYS SO** (`lib/sandbox/output-clip.ts`, wired into `bash`, `getProcessOutput` and `readFile`). The old cut was `clamp(text, 12_000)` — head-only, with a bare `…` — which is indistinguishable from the output simply ending: asked what models the HackClub proxy serves, kyto ran `curl …/v1/models | jq .`, was handed 12k of a ~3MB document, and reported that the model it was itself running on is not listed. Now the first ~8k chars and the last ~3k are kept (whole lines; a build's verdict is its LAST line, which the head-only cut always threw away), separated by a notice stating total lines/chars, how many lines are hidden, and "do NOT conclude anything from what is absent here". The **complete** output is written to `/tmp/kyto-output/<stamp>-<stream>-<rand>.txt` in the sandbox so the model can grep it instead of re-running the command; saving is best-effort and the notice says so when it failed. `readFile` points back at the file itself rather than saving a copy.
- **`bash` auto-backgrounds a slow command** (`tools/sandbox.ts` + `tools/background.ts`): a foreground command still running after **60s** (`AUTO_BACKGROUND_MS`) is moved to the background instead of freezing the turn — the tool returns a handle (`bg-N`, `running: true`) and the model polls via `getProcessOutput`/`killProcess`. Every command runs detached (nohup, separate stdout/stderr/exit files), polled up to 60s; a fast command returns transparently. `bash` shares the **one** `backgroundProcessTools` registry (built before `core` in `toolset.ts`). Handles are per-turn (in-memory).
- **`wait`** (core): a bounded, abort-aware mid-turn pause, up to **1 hour**. It calls `extendAttemptDeadline` (threaded from `agent/index.ts` through `buildTools`) so the watchdog treats a long pause as work, not a stall. `pauseSandbox: true` suspends the sandbox (`session.destroy()` pauses a persistent sandbox; the next command auto-resumes) — ignored under 120s; suspends background processes too.
- **`writeFile`** takes `append`. One tool call can't carry a very large file (its args ride in the model's token budget), so the description tells the model to chunk a big write (`append:false` then `append:true`).
- **`editFile` is exact-match and fails loudly.** `oldString` must match byte-for-byte and (without `replaceAll`) exactly once; a miss or an ambiguous match refuses instead of guessing. On a miss `noMatchReason` names WHICH of the three usual causes it was — CRLF vs LF, whitespace-only difference (checked by comparing both sides with runs of whitespace squashed), or a first line that does match so the divergence is later — because a bare "not found" sends the model into guess-and-retry.
- **Post-edit diagnostics** (`lib/sandbox/diagnostics.ts`, wired into `writeFile` + `editFile`): after a successful write the file is checked and any errors ride back in the tool result as `diagnostics: {checker, output}`, so the model sees what it just broke instead of only finding out if it thinks to run something. Per-extension parse check first (`node --check`, `py_compile`, `bash -n`, JSON parse, `bun build` for TS/JS), then — for TS/JS only — the nearest `tsconfig.json` above the file plus the nearest `node_modules/.bin/tsc` above THAT, run as `tsc --noEmit -p`, output filtered to lines naming the edited file (an unrelated pre-existing failure is not this edit's diagnostic). **Two invariants**: a check that cannot run (missing interpreter → exit 127, `timeout` → 124, unknown extension, sandbox threw) reports NOTHING — a fabricated error is worse than none; and it is advisory, the write still succeeded. The project typecheck is debounced per sandbox+directory (`TYPECHECK_MIN_INTERVAL_MS`, 10s) so a burst of edits doesn't pay for it each time, and `append` writes are skipped entirely — a chunked file is incomplete by construction and would report "unexpected end of file" on every chunk but the last, which just teaches the model to ignore diagnostics. The module is deliberately free of `@/lib/logger` (and so of the validated env) so its tests can run the REAL checkers.
- **`fetchUrl` goes through `publicFetch`** (`lib/public-url.ts`): host checked before the request and at every redirect hop, body read capped at 5 MB — it runs on kyto's host, so `169.254.169.254` or a neighbouring container would otherwise be read back. The same guard covers a BYOK base URL (save, validation, every turn).
- **`fetchUrl` rejects Slack links** (`isSlackLink`): a `*.slack.com` URL 302s to a login wall, so it refuses and points to the Slack read tools (readConversationHistory for a message — path `/archives/<CHANNEL>/p<TS>`; getFile for a file).
- **`getFile` sends the bot token ONLY to Slack hosts** (`isSlackFileHost`): the download carries `Authorization: Bearer SLACK_BOT_TOKEN`, so the resolved URL must be `files.slack.com`/`*.slack.com`/`slack-files.com` over https — any other URL is refused before the header is attached. Do NOT restore an arbitrary-URL passthrough: a prompt injection once used it to mail the bot token out in the auth header. Non-Slack URLs go through `fetchUrl` or the sandbox.
- **Email** (`tools/email.ts`) runs **host-side** via the AgentMail SDK using `AGENTMAIL_API_KEY`; registered only when that key is set. Not in the sandbox.
- **Image generation** (`tools/generate-image.ts`) calls HackClub's **chat/completions** directly (`google/gemini-3.1-flash-image`, `modalities: ['image','text']`), one call per image (`n` in parallel). NOT `/images/generations`: since 2026-10-03 it answers "Unknown model" for this id though `/models` lists it. The AI SDK `generateImage` path never reached the proxy — don't go back to it. Takes `upload` (default true): every image is ALSO written to `<workspace>/generated-images/` and its path returned, so a picture survives a failed upload and can be edited or served from a site; `upload:false` generates without posting to Slack. Saving materializes the sandbox — deliberate, so an image is never generated and then lost. **EDITING** is the same call with the images attached (`/images/edits` 404s on this proxy); it answers in `message.images[].image_url.url` as a data URI. `editPaths` (≤4 sandbox paths, ≤8MB each) takes that path — "make the background blue", "combine these" — and an image someone posted is already on disk via `seedAttachments`.
- **Emoji** (`tools/emoji.ts`, both DEFERRED). `lookupEmoji` resolves a custom emoji name (following `alias:` chains) off a 30-min cached `emoji.list`, fetches the image from emoji.slack-edge.com **with no Authorization header** (those URLs are public, and the bot token only ever goes to Slack API hosts), and has the vision model say what it depicts and what reacting with it would mean — a workspace's custom emoji are a private language a model only ever sees the NAME of. `search:true` lists matching names instead. Needs the `emoji:read` scope.
  - `submitEmoji` **adds the emoji DIRECTLY when `KYTO_USER_TOKEN`/`KYTO_USER_COOKIE` are set** (`lib/emoji-upload.ts`), and it is live immediately. Slack has NO public API for this — `emoji.add` is an internal endpoint that only accepts a browser session (an `xoxc-` token plus the matching `d` cookie, copied from devtools), which is what `#emojibot` does too. That pair is **a whole Slack account, not a scoped token**, so: it is kyto's OWN user account since 2026-09-29 (it was the owner's; ANY user may trigger an upload — every emoji lands under "kyto"), it lives in the ENV and never in the DB, a sandbox or a log, and besides `addEmoji`/`removeEmoji` only `postMessage`'s `fromUserAccount` uses it (see GATING.md). No general "call Slack as that account" helper. 10 per person per UTC day (in memory, resets on restart), and each upload logs who asked. `removeEmoji` is **owner-only** — Slack allows removal only for the adding account, so an open version would let anyone delete anything kyto ever added for anyone.
  - Without those credentials it falls back to the old path: uploads ONE image into `EMOJI_REQUEST_CHANNEL` (`#emojibot`) with the **bare name as the message text** — that exact shape is what the emoji bot in that channel parses (verified against the channel's history: `hedgehog`, `crack-ani`, `ember-sit-new`; its own error is "Please upload one image at a time"). No colons, no "requested by", no note, one image per message, or the submission is just a message nobody acts on. **Open to EVERYONE** (owner's call, 2026-08-06 — it was owner-only for a week). It does put a FILE into a channel kyto was not invoked in, so the rails are all inside the tool: `EMOJI_NAME` makes a control token unrepresentable, `neutralizeBroadcast` runs anyway because `filesUploadV2` bypasses `ThreadHandle.post`, Slack's 128KB limit is refused up front rather than posted and discarded, and a `[emoji] submitted` log line names the Slack user who asked — the channel only ever shows "kyto", so that line is the entire audit trail. Attribution deliberately does NOT go in a thread reply: the emoji bot parses REPLIES too (a reply of "gng" removed an emoji that had just been added).
  - **It then waits up to 30s for the emoji bot's verdict** in that thread and hands the reply back, because "posted" is not "added". That bot sometimes answers with a CHOICE ("upload as is" / "without background") in a message ephemeral to the poster — the poster is kyto, a bot never receives ephemerals, and Slack has **no API for pressing a button on another app's message**, with a bot token or a user token. So kyto genuinely cannot finish that path; the tool says so and hands back a permalink for a human. Do not "fix" this with `SLACK_USER_TOKEN` — that only moves the ephemeral to the owner, it does not make it clickable by code.
- **Sandbox git safety** (`packages/sandbox/src/git-safety.ts`, wired in `lib/sandbox/git-safety.ts`): a repo that arrives as an archive/clone carries executable config with it. Every materialization runs `GIT_HARDEN_COMMAND` (global `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `protocol.ext.allow=never`), and after any tool call that could have fetched a repo (`mayHaveFetchedRepo` — tar/unzip/curl/clone/…) `sanitizeGitRepos` deletes every `.git/hooks/*` and strips the command-executing keys from each repo config (`core.hooksPath`/`fsmonitor`/`sshCommand`/`pager`/`editor`, `diff.external`, `include.path`, and the `[filter "x"]`/`[diff "x"]`/`[alias]`/`[credential]`/`[includeIf]` sections). Repo-local config is the reason the sweep exists at all: it would otherwise override the global hook path. Runs from `bash`, `gh`, and background processes (on the poll that first sees them finish).
- **Web search** (`searchWeb`) uses Exa via `EXA_API_KEY`. The placeholder key (`exa-placeholder-no-websearch`) returns `ExaError: Invalid API key`.

## Browser

`browser` (`tools/browser.ts`, deferred) runs the preinstalled `agent-browser` CLI **inside the sandbox** (pass CLI args in `command`; run `skills get core` first). It drives **CloakBrowser** (`lib/browser/cloak.ts`, `ensureCloakBrowser`), a Chromium with ~66 source-level C++ fingerprint patches (canvas, WebGL, audio, fonts, GPU, WebRTC, automation signals), so anti-bot systems score it as ordinary and **most sites never serve a challenge**. It does NOT solve captchas — it prevents them. Every call first runs an idempotent ensure script: exit if CDP on :9222 answers, else install `cloakbrowser`, launch it **headful under Xvfb** (headless gets flagged; falls back to `--headless=new` if Xvfb won't install) with `--fingerprint-platform=windows`, then `agent-browser connect 9222`. A pause kills the Chromium but keeps the cached binary. `cloakbrowser` + `xvfb` + `xauth` are baked into the E2B template — and the DEPLOYED template can drift from `build-template.ts`: the published `gorkie-sandbox:3.0` predated the cloakbrowser bake-in, so every browser call failed with "could not install the stealth chromium binary" (runtime `npm install -g` isn't a reliable fallback). After editing `build-template.ts`, republish with `bun run build:template` and verify with a fresh `Sandbox.create` probe. If the Xvfb launch fails, the ensure script now retries `--headless=new` before giving up (xauth was missing once — `xvfb-run` hard-requires it and `noInstallRecommends` skips it).

**Live view** (`packages/sandbox/src/live-view.ts`, owner's ask 2026-09-29, from coolton): the browser's FIRST call in a turn also starts x11vnc + noVNC on the shared display and posts a watch link into the thread (`getHost(6080)`, random 8-char VNC password in the URL); later calls in the turn reuse it. **`x11vnc -viewonly` on the SERVER is load-bearing** — the link is public in the thread and noVNC's `view_only=true` is only a client default, so without it any reader drives a possibly-logged-in browser; the script replaces any x11vnc lacking the flag. It checks liveness by PORT and `pgrep -x`, never `pgrep -f` (the script's own text matches, which silently skipped the start). Not on a `!secret` turn (`buildTools({secret})`). The link dies when the sandbox pauses at turn end. The noVNC web client comes from its GitHub release into `/opt/novnc`, NOT Debian's `novnc` package — that depends on the distro nodejs the template purges (so it vanished from the first rebuild), and a runtime apt install would drag that nodejs back over the real Node.

If a captcha DOES appear, the tool/prompt tell the model to snapshot the page and **click the checkbox like a person** — never to claim it can't before trying. **Scripting it directly**: the sandbox prompt says `cloakbrowser` is a real npm package (a stealth Chromium, drop-in Playwright/Puppeteer replacement), so for a loop or scheduled job the model writes a Node script against it. The **headful rule** applies there too: run under `xvfb-run -a node script.js` with `fingerprintPlatform: 'windows'`, or it gets flagged.

`slackBrowser` (`tools/slack-browser.ts`, deferred, OWNER ONLY): agent-browser (an `apps/bot` dependency, native binary spawned directly) against a headless Chromium on KYTO'S HOST (`lib/slack-browser`; Debian `chromium` + `openssl` + `tini` as PID 1 (reaps what Chromium orphans) in the Dockerfile, which also chmods the agent-browser binaries bun installs non-executable) — not E2B, whose 976 MB/no-swap box froze on Slack's ~740 MB page (sidebar drawn, messages never, then "tab is not responding"; owner's call 2026-10-02, also saves sandbox time). One browser per turn, started on first use: temp profile, `--remote-debugging-port=0` (read back from `DevToolsActivePort`), a per-session loopback TLS proxy (`startSlackWebProxy`, port 0, one EC key per process minted with openssl, trusted via `--ignore-certificate-errors-spki-list`) and `--host-resolver-rules` (`resolverRules`: CDNs `EXCLUDE`d, Slack `MAP`ped to the proxy, `MAP * ~NOTFOUND`). Commands go through `parseCommand` (allowlist, see GATING.md), 90s cap; `restart` relaunches a stuck browser. Live view: `lib/slack-browser/live-view.ts` attaches to CDP, follows the newest page tab, `Page.startScreencast` JPEGs fanned out over `/_slackview/<id>/socket` to a tiny page (CSP-locked, frameable, so `/embeds/live-*` can play it in-message); the id is unregistered at close, so the link 404s after. `close()` ends the view, `agent-browser close`, kills Chromium (SIGKILL after 10s), stops the proxy, deletes the profile. edgeapi `/cache/` POSTs are READS and pass the proxy — refusing them half-broke the client. The plain `browser` live view falls back to posting from the user account when the app can't post in that channel.

## Subagent

`tools/subagent.ts` — a headless copy of kyto: **shares the parent turn's sandbox** (`getSandboxContext` from `toolset.ts`), the full toolset, driven by the same `streamAttempt` loop, returning its final text as a report. Deferred; registered only when a subagent model exists.
- **Nesting is ONE level** (`MAX_SUBAGENT_DEPTH = 1`).
- **Background job ids are per THREAD** (module-level map, per-thread counter, a finished job kept an hour): a steer, resume or wake runs a fresh `runTurn`, and a per-turn map turned a still-running `sub-2` into "Unknown id" (issue #29). In memory — a restart loses them, as it does the jobs.
- **It must NOT create or destroy the sandbox** — the parent owns the lifecycle. The subagent's `finally` only closes per-turn tool/MCP connections.
- **Model roster + report fallback** (`subagentAttempts`, `providers/attempts.ts`): the owner's Gemini models first (`gemini-3.1-flash-lite` leads), then a single HackClub rung as the floor so the tool still works with no Gemini key. The subagent **walks this list** on an error OR an empty report (one pinned cheap model made a "herd" of subagents report nothing). If a model ran tools but wrote no prose, `synthesizeReport` re-asks THAT model once with **tools off**.
- **Report to parent**: the foreground path returns `{report, success:true}` as the tool RESULT.
- **Background + `checkSubagent`** (`background: true`): registers the job in an in-turn registry (ids `sub-1`…) and returns immediately. `checkSubagent`: no id → lists all; with an id → status + report once done; `wait: true` blocks. Per-turn registry (like bash background processes).
- **It gets its OWN streamed plan message, named for it** (`slack.stream(thread.id, …, { username: label, taskDisplayMode: 'plan' })`, label = `kyto subagent` / `kyto subagent {name}`, no icon override): a **Prompt** card (full task, unclamped), a **Model** card per attempt, the same interleaved thinking/tool cards a real turn shows (shared `renderStream`, no `emitText`), then a **Response** card with the full report. Ids need no namespacing — they live in that message alone, so two concurrent subagents can't collide. **NOTHING goes in the message body**, so the subagent never speaks: the report reaches people only when the parent says it.
  - This was briefly folded into the PARENT's plan instead (a `ChunkRelay` racing the model stream in `streamSegmented`), because the subagent's answer read as kyto answering twice. **Owner's call, 2026-07-30: the distinct card comes back** — an empty body is what prevents the double voice, not merged cards. The relay is deleted; the label rule stays fixed (nothing configurable decorates it).
- Runs on a slimmer prompt (`subagentSystemPrompt`): a lean `<subagent>` core + sandbox + context, without personality/tone, the custom-instruction hierarchy, broadcast etiquette, or media/copyright framing. Keeps finish-the-job, parallel-tool, loadTools, private-auth, SFW, report-back guidance.

## Recurring reminders

`tools/reminders.ts`, `lib/reminders/scheduler.ts`, `@repo/db` `reminders`. Unlike the one-time `scheduleReminder` (Slack's native `chat.scheduleMessage`), recurring reminders are driven by kyto's own always-on process (Slack has no recurring-schedule API). A row holds `user_id`, `text`, `recurrence` (`interval`|`daily`|`weekly`|`cron`) plus schedule fields (`cron`: a five-field `cron_expression` read in an IANA `timezone`, default UTC, via `croner`; the kind's minimum interval is checked against the gap between its next two fires; an expression with no future fire deactivates the reminder), `next_run_at`, `channel_id` (fire into a channel vs DM — **owner-only**, same gate as cross-channel posting), `max_runs`/`run_count`, `thread_id`, `kind`, `editor_user_ids`. `startReminderScheduler` polls every 30s, CLAIMS each due reminder by advancing `next_run_at`, then fires it; a failed post is retried twice and, for a channel target, DM'd to the creator (the claim means the scheduler never retries it). Agent fires time out at 15 min. Posts honor the reminder identity profile; a channel-targeted reminder prefixes `<@user>`.

**Kinds** (`reminders.kind`) + interval floors:
- `message` (default, 60s): posts `text` verbatim.
- `script` (60s): fetches `url` each fire and posts its content (`fetchUrlText`).
- `bash` (5 min; `lib/reminders/bash.ts`): runs `command`, posts stdout/stderr, **in the persistent sandbox of the thread it was created in** — so it can run a script kyto wrote earlier. A row without `thread_id` falls back to `runOnce` (throwaway sandbox, empty every fire).
- `agent` (1 hour; `lib/reminders/agent.ts`): runs a **headless kyto** (same loop, full toolset, nothing streamed) with `text` as instructions and posts the final reply — UNLESS the job itself already `postMessage`d into the conversation the reminder lands in (a job told to "report to #kyto"), which used to give two posts there. Pinned to the cheap subagent model. Reuses the thread's sandbox. `searchSlack` does NOT work here (its action token needs a live interaction).

Tools: `scheduleRecurringReminder`, `listReminders`, `pauseReminder`, `resumeReminder`, `cancelReminder`, `editReminder` (only the fields passed are touched; a new schedule takes effect from now; a bare `intervalSeconds` is re-floored against the kind). An **App Home "Reminders"** section lists each reminder a user may act on with Pause/Resume/Delete.

The scheduler fires due reminders **concurrently** and guards **overlapping fires** with an in-flight `Set` — a row is advanced only *after* it fires (else a multi-minute run restarts every poll). `advanceReminder` computes the next run from `max(nextRunAt, now)`, so a schedule left in the past doesn't re-fire every poll.

## Channel directory (Flaron)

`getChannelInfo` falls back to Flaron (`lib/flaron.ts`, https://flaron.halceon.dev, public and keyless, owner's pick 2026-10-02) when the bot can't see a channel, and returns `visibility: private|public|nonexistent` from Flaron's `/cman` (explicit `"private"`). The bot sees every public channel, so an unseen one is usually private — kyto once called a private channel public and joinable off a search hit. `findChannels` (deferred) merges Flaron's name search (PUBLIC only; private needs its admin key) with an exact-name lookup, which does resolve a private channel's name. `searchSlack` keeps `channelIsPrivate` from the user-token path.

## Slack search

`assistant.search.context` runs with the **requesting user's** own Slack access, so it reaches private channels/DMs that user is in — but only with granted scopes (`search:read.public`/`.files`/`.users`/`.private`/`.im`/`.mpim`; the last three were missing once, silently limiting every search to public channels).
- **Cost**: returns `limit: 10` matches with `include_context_messages: true`; those context messages dominate input tokens and ride along in every subsequent step (a turn can balloon to 100k–270k tokens). We trim each match to the **2 nearest before + 2 after**. Drop `limit` or trim further if cost climbs.
- **Modifiers**: the `query` supports Slack's full search-bar set, combinable — `from:`, `to:`, `in:` (`#channel` or `@user`), `on:`/`before:`/`after:`/`during:`, `has:link`/`star`/`pin`/`:emoji:`, `is:thread`/`dm`/`external`, `filename:`, `ext:`. In the tool description + core prompt so the model narrows queries.
- **Hit text is capped** (`searchSlack`): 800 chars per hit, 300 per context message, marked with how to read the rest (`readConversationHistory`, threadTs = messageTs). A page of 20 full hits over long messages was ~10k tokens a call, each written once at 1.25x (owner's call 2026-10-08).
- **Action-token urgency**: the `action_token` expires ~2 min after the turn starts, so the core prompt tells the model to run all `searchSlack` calls early.

## Slack read-only scripting (host-side proxy)

**The `slack` helper is SELF-DOCUMENTING on purpose** (2026-08-08): `slack --help` (and no args) prints the usage plus the allow-listed methods, an option-looking argument is rejected as one, a non-proxied method is named locally with the list instead of costing a round trip, and a second argument that is not a JSON object says so. A turn was lost without it: the model tried `slack conversations.replies --verbose '{...}'`, the flag landed in `$2` and was POSTed as the body, the proxy answered `invalid_json_body`, and the model concluded `conversations.replies` was not proxied — it is — then spent three more steps guessing at the argument format.

`slackScript` (deferred, gated on `SITES_ENABLED`) runs a bash script for **aggregate** Slack questions in one script instead of N tool round-trips. It POSTs to a **host-side, secret-gated, READ-ONLY proxy** on the sites server at `/_slackapi/<method>` (`lib/slack-proxy/`). The **bot token never enters the sandbox**: the proxy attaches the real token and forwards ONLY the `READ_ONLY_METHODS` allowlist (users.*, conversations.*, team.*, usergroups.*, reactions/pins/bookmarks list, emoji.list). (Our bot token isn't itself read-only, which is why it can't just be handed to the sandbox.) **Per-turn Slack budgets** (Slack's rate limits are shared by every turn and kyto's own replies): the proxy answers 429 `turn_budget_exceeded` past 300 calls per turn token, and `trackUse` refuses the Slack read tools (`SLACK_READ_TOOLS`) past 120 calls per turn, telling the model to narrow down.

**`slack` is a real executable on PATH**: `slackHelperInstall()` is `LazySandbox`'s `bootstrapCommand`, run each time a sandbox materializes (create AND resume — must stay idempotent). So the plain `bash` tool and a `bash` reminder can query Slack read-only too. The helper reads `KYTO_SLACK_PROXY[_TOKEN]` **from the environment at call time** and `run()` re-sends env on every command — that's what lets a *persistent* sandbox outlive any single turn's token, and why a **`bash`/`agent` reminder mints a fresh proxy token at fire time and revokes it after**. No search method is in the allowlist, so "count a user's messages" means paging `conversations.history` per channel (slow, not a bug). A subagent shares the parent's sandbox, so `slackScript`/`codeMode`/`slack` work inside it too.

## Focus mode

`focusMode` (core) locks kyto onto specific user ids in the current thread: it only replies to those users AND their messages are the only ones it **sees** — non-focused messages are filtered out of the prompt (`isFocusAllowed`, `lib/agent/focus.ts`), so others can't hijack it in a public thread. The **owner is always allowed through** and kyto's own messages always stay in context. Gated in `bot.ts`; persisted on `thread_subscriptions.focus_user_ids`. `clear: true` turns it off. There is also a typed form that costs no turn — see the command prefix in CLAUDE.md.

The owner exemption is a fact kyto must KNOW but not advertise: the tool result carries a `note` saying never to promise to ignore the owner and not to mention the exemption unprompted, and the success `summary` no longer claims "I'll only respond to your messages here". kyto had told a user exactly that in a thread the owner was in — a promise it cannot keep.

## Slack reference docs

`slackDocs` (deferred, `tools/slack-docs.ts`): curated reference notes the model loads before composing something non-trivial — `block-kit` (block types + limits, mrkdwn vs the `markdown` block, the "invented action_ids do nothing" warning), `canvas` (canvas markdown incl. `- [ ]` clickable checkboxes and `![](@U…)` mentions — added because kyto once drew emoji squares instead of real checkboxes), `search` (the full modifier set). Content is inline TS constants written from the official docs (docs.slack.dev, the search help article) 2026-07 — refresh there when Slack changes. `canvasWrite`'s `markdown` param description carries the checkbox rule inline so the common case doesn't require the load.

## Canvases and pins

- `canvasList` takes an optional `channelId`; on `not_in_channel` it joins the public channel **silently** and retries.
- `canvasWrite` create modes accept `title`. `create-channel` best-effort **adds the canvas as a channel tab** by bookmarking its permalink (`addCanvasTab`). Needs `bookmarks:write` + `files:read`.
- `pinMessage`/`unpinMessage` take an optional `channelId` and `as: 'bot' | 'user'`. As the bot, `not_in_channel` triggers one `conversations.join` + retry. `as: 'user'` pins as the owner via `SLACK_USER_TOKEN` and is owner-gated. Needs bot `pins:write` and, for `as:'user'`, the user-scope `pins:write`.

## Static site hosting

`deploySite`/`removeSite`/`listSites` publish static sites at `https://<host>/<name>/` (default host `kyto.devansh.hackclub.app`). Code in `lib/sites/`. The host **never executes site code** — building/testing happen in the E2B sandbox; only static output is copied out (`resolveWithin` path containment). Both tools take an optional `page` sub-path (`docs/intro`), served at `/<name>/<page>/`, validated by `isValidPagePath`; a page deploy atomically swaps only that sub-path. The server starts from `apps/bot/src/index.ts` (`startSitesServer`) and serves **plain HTTP** by default (it sits behind Nest's TLS-terminating proxy; serving HTTPS there → 502); `SITES_TLS=true` for a self-signed cert standalone. Config: `SITES_ENABLED`, `SITES_PORT` (8080), `SITES_TLS`, `SITES_ROOT` (`/var/kytosites`), `SITES_PUBLIC_HOST`.

## Asking people questions (`askQuestion`)

Deferred. Posts a PUBLIC message in the current thread with option buttons and
WAITS (up to 10 min) for an answer, then returns it.

- **Public, not ephemeral** (owner's call): an ephemeral vanishes on reload,
  can't be answered later, and hides from the room that a decision is pending.
- **Gated to the addressed people.** Only the `askUserIds` may answer; anyone
  else clicking is told so ephemerally rather than ignored (a dead-looking
  button reads as a bug). This is what makes it a question and not a poll.
- Single or `multiSelect` (toggle, then Done). Optional `allowOther` adds an
  "Other…" button opening a modal; the modal re-reads state from the message it
  came from rather than trusting its payload.
- It waits for **everyone** asked, not the fastest, and extends the attempt
  watchdog (`extendAttemptDeadline`) so a deliberate pause is not a stall. On
  timeout the model is told nobody answered, not to re-ask this turn, and not
  to invent an answer.
- State lives in the message's Slack metadata (like `poll`), so a restart leaves
  a working message. The waiting turn is in-memory — a turn doesn't survive a
  restart either.

## Per-user MCP servers (`lib/ai/mcp.ts`, `lib/ai/mcp-permissions.ts`)

Remote Streamable-HTTP servers a user adds in **App Home**. Hand-rolled JSON-RPC
client, listings cached 10 min per URL+credential, tools namespaced
`mcp_<server>_<tool>` and deferred behind `loadTools`. The security rules
(`never` = never registered, who may click an `ask` prompt, no DM fallback,
unattended refuses, fail-closed parsing) are in CLAUDE.md — read them before
touching the gate. The mechanics:

- **Classification** (`classifyMcpTool`, pure + tested) is layered because servers
  disagree about how much they say: MCP `annotations.readOnlyHint` /
  `destructiveHint` first, then the ability the description STATES
  (`/requires? (the )?<ability> (ability|scope|permission)/i` → `sensitive` if it
  contains "sensitive", `write` for `deploy|write|root|admin|manage|owner|delete|full`),
  then name verbs, then a "returns a secret" word list (`logs`, `env`, `secrets`,
  `tokens`, …) for reads that can leak. `write` beats `sensitive`; a name verb
  outranks a bare `readOnlyHint: true` for sensitivity, because a read-only tool
  can still be the one that hands back the credential. Unmatched stays `unknown`.
  Coolify ships `annotations: {}` on all 45 tools, so a fully spec-shaped server
  can still tell you nothing — the stated-ability layer is what carries it.
- **Rules** are `allow | ask | never` per category, plus `tools: {name: rule}`
  overrides that win over their category (`resolveMcpRule`). Stored in the
  untyped `rules` jsonb column and parsed at the boundary, never cast.
- **The modal does both jobs** (`buildMcpModal`): `callback_id` and submit label
  flip between add and edit, the four category selects and the per-tool-pins
  textarea are inline (no second configure step — owner's ask), and the row is
  identified by the view's `private_metadata`. Pins round-trip as
  `tool_name: rule` lines; a malformed line is REPORTED as a field error, since
  silently dropping one leaves someone believing they blocked a tool.
- **Token replace/clear**: the modal never shows a saved token back, so a blank
  field means KEEP (`updateMcpServer` omits `authorization`) and removal is the
  explicit `mcp_token_action: clear`. A two-option `static_select`, not a
  checkbox — the harness reads `value ?? selected_option.value`, so a checkbox's
  `selected_options` would arrive `undefined`.
- **Always / Never on a prompt writes a per-tool pin** (`pinRule`,
  read-modify-write off the fresh row so it can't clobber a category rule changed
  while the prompt was open), then `forgetMcpFailure` so the next turn re-derives
  the server instead of reporting a pre-decision verdict, then republishes Home.
  `pinRule` looks the row up by `gate.serverId` and REFUSES unless the clicker is
  `gate.ownerUserId` — on a shared server anyone present may allow a single call,
  but a standing rule belongs to whoever's credential it runs on.
- **Sharing** (`mcp_server_shares`, `buildShareMcpModal`, `resolveTurnMcpServers`):
  a `multi_conversations_select` for channels plus a `multi_static_select` for
  groups, replacing that server's shares wholesale. `sharedBy` is written from
  the acting user, never the form; group ids are re-checked against real rows.
  The turn's list is `own ∪ shared`, de-duplicated by row id, own servers first
  and keeping their names, collisions suffixed `_2`/`_3` — deterministic, so the
  tool array does not reshuffle between turns and cost the thread its cache.
  The multi-select values arrive on `ModalSubmitEvent.multiValues` (the flat
  `values` map only carries `value`/`selected_option.value`).
- **URL safety** (`lib/public-url.ts`, tested): `checkPublicUrl` on save (scheme,
  blocked hostnames/suffixes, private literals) and `assertPublicHost` before
  every JSON-RPC call (DNS resolve, 60s memo). Both, not either — a save-time
  check alone loses to a hostname repointed afterwards. IPv6 is an ALLOWLIST
  (global unicast `2000::/3` only, embedded v4 checked): the URL parser rewrites
  `::ffff:127.0.0.1` to `::ffff:7f00:1`, which a regex denylist missed. MCP
  never follows a redirect (the hop would carry the credential).

## Approvals (`lib/approvals/`)

Not a tool the model calls — a gate the tools go through. `approval_requests` is
persisted, posted publicly in the thread, and never expires. Reached by: a
non-owner's cross-CHANNEL `postMessage`, a broadcast ping that would otherwise
be silently stripped, and a third-party GitHub write. The turn does not block;
the model is told the action is queued and carries on. Security rules are in
CLAUDE.md — read them before adding a new `ApprovalKind`, and never add one for
`sendAsUser`/`editAsUser`.

## Ownership & edit permission (reminders + sites)

Things kyto creates on someone's behalf and can later change carry an access list, so a bystander in a public thread can't rewrite someone's reminder or take down their site. The rule, shared by both: **the creator, anyone the creator named as an editor, and the bot owner.** The core prompt tells the model the rule, and that a refusal is not to be worked around.
- Set at creation via optional **`editors`** on `scheduleRecurringReminder` and `deploySite` (user ids or `<@U123>`; `parseEditors` in `tools/editors.ts` rejects anything that isn't a user id, so a display name can't become a permission entry that never matches). Omitted = creator only.
- Enforced **at execute time against `message.author.userId`** — the person actually talking this turn, not whoever the model claims to act for. Reminders: `isReminderEditableBy` + `editableBy` (a jsonb `@>` check) scope every list/pause/resume/cancel/edit. Sites: `checkSiteAccess` + `canEdit`.
- Storage: `reminders.editor_user_ids` (jsonb) and the `sites` table (`name` PK, `owner_user_id`, `editor_user_ids`). First deploy of a name **claims** it; a whole-site `removeSite` releases it, removing one `page` does not. Sites published before the table existed have no row — `siteExistsOnDisk` makes them bot-owner-only.

- **Live embeds** (`tools/embed.ts` + `lib/embeds.ts`, DEFERRED). `embed` posts a Slack **`video` block**, which iframes any URL right inside the message and lets people interact with it — that is all coolton's "whiteboard" ever was. Two kinds: `html` (a self-contained page the model writes) and `whiteboard` (a shared live Excalidraw canvas, see below). Pages are hosted by kyto itself under the reserved `embeds` site name, so `deploySite` can never take that name and a whole-site deploy wipe every live embed. Re-publishing an id swaps what an existing message shows; `removeEmbed` deletes the page.
  - **Slack requires `links.embed:write` AND the domain registered as an app unfurl domain.** Only `kyto.dino.icu` is registered, so kyto cannot be talked into embedding an arbitrary site.
  - **An embed must be frameable, so `X-Frame-Options` is dropped for `/embeds/` and nowhere else.** The dashboard keeps it — a frameable password form is a clickjacking target. An embed page carries no session and no form.
  - **The whiteboard is genuinely multiplayer, on EXCALIDRAW** (`lib/whiteboard/`, 2026-08-11). Everyone on a board shares one drawing and sees each other's cursors; it is saved and survives a restart. Verified in a real browser against the live host: two pages, one draws, the other shows it, and it is still there after `systemctl restart`.
    - **tldraw is BANNED here, and it is a licence problem, not a bug.** The first build used tldraw and went blank in Slack — `LicenseProvider.shouldHideEditorAfterDelay` replaces the editor with an empty div **5 seconds** after load when the state is `unlicensed-production`, and their "development environment" means localhost only. The tldraw licence says "Not to use the Software in Production Environments" without a paid key AND "not to interfere with the key enforcement", so pinning the older 3.7.0 (which only watermarked) is not a way round it. Excalidraw is MIT with no key, no gate and no watermark.
    - **The sync protocol is ours**, four messages: server `init` on join, client `update` with what changed, server `update` relayed to the rest of the board, and `pointer` (ephemeral, never merged, never saved). One Bun pub/sub topic per board.
    - **Which copy of a shape wins is the whole algorithm**, so it lives alone in `merge.ts`, is tested, and is imported by BOTH halves — two implementations that disagree is how a shared canvas silently forks. Excalidraw's own rule: higher `version`, tie broken on the higher `versionNonce` (arbitrary but identical on every peer). A delete is an element with `isDeleted` and a higher version, KEPT as a record: dropping it lets a peer holding the older copy resurrect the shape. Remote edits apply with `captureUpdate: NEVER`, so ctrl-z never undoes someone else's work.
    - **The room is resolved BEFORE the socket upgrade**, because Bun does not wait for an async `open` handler: a board still loading from disk would drop the first messages. Concurrent opens collapse onto one in-flight promise — two rooms for one board would each think they were authoritative.
    - **A socket is refused unless kyto published that board** (`<id>.board` marker under `SITES_ROOT/.whiteboards/`). Without it any URL of the right shape would mint a document on kyto's host.
    - **Saved with a 3s debounce and an atomic rename, flushed on SIGTERM** (kyto restarts after every change), idle rooms closed after 10 min, ceilings on open rooms and elements per board. `removeEmbed` deletes the drawing and the marker with the page.
    - **The client is BUILT BY KYTO** (`page.ts`, `Bun.build`, ~7.7MB once per process, served from `/embeds/_assets/`), and Excalidraw's fonts are copied out of the package — it fetches them from unpkg at runtime otherwise. `client.browser.ts` is the one file in the bot that runs in a browser: excluded from `tsc` (no DOM lib) and a knip entry point (nothing imports it; `Bun.build` takes its path).
    - **Anyone with the URL can draw on a board.** There is no per-user auth on the socket, exactly like a deployed site is public.

## Sandbox persistence details (moved from CLAUDE.md)

  - Persistence is opt-in via the injected **`SandboxStore`** so `packages/sandbox` stays DB-free (`lib/sandbox/store.ts`); a `LazySandbox` without a store is ephemeral.
  - **A thread, not a "conversation."** Every message roots its own thread, so a new top-level DM gets a **new** sandbox.
  - **The create-time `envs` are stale on a resumed sandbox.** Per-command env IS re-sent on every `run()`, so the short-lived Slack and GitHub proxy tokens stay fresh.
  - **A thread's sandbox is one mutable machine**; a live turn and a `bash`/`agent` reminder both reach for it. `acquireThreadSandbox`/`withThreadSandbox` serialize them (a turn holds the lock its whole duration).
  - **A paused sandbox costs storage**, so `startSandboxReaper()` (hourly) kills anything untouched for **30 days** (`SANDBOX_TTL_DAYS`). It is ACTIVITY-based (`touchThreadSandbox`), so a sandbox kept warm never ages out — that is how long a compromised one survives. `runOnce()` spins a throwaway sandbox for callers with no thread.
  - **ONE shared virtual display** (`packages/sandbox/src/display.ts`, `kyto-display` on PATH): the headful browser needs X, and callers starting their own killed each other and left `/tmp/.X99-lock` behind, after which every start failed. It is idempotent and clears a stale lock; nothing else may start an X server.


---

# Architecture and sandbox as they stood in CLAUDE.md (moved 2026-09-29)

Verbatim, so nothing was lost when CLAUDE.md was trimmed.

## Architecture — fully custom harness

The Vercel Chat SDK, the Pi framework, and `@ai-sdk/harness*` were removed in a ground-up rewrite. Kyto runs on:

- **Custom Slack harness** (`apps/bot/src/harness/`) — `@slack/socket-mode` + `@slack/web-api` directly. `SLACK_APP_TOKEN` required (Socket Mode is the only mode).
  - `SlackHarness` (`harness.ts`): Web API facade — thread-id codec `slack:CHANNEL[:TS]`, message building, fetch/history/listThreads, reactions, assistant status, native streaming via `webClient.chatStream` (task cards = `task_update` chunks, `task_display_mode: 'plan'`). `fetchMessages` takes `oldest`/`maxPages`; a returned `nextCursor` means the tail was not reached.
  - `KytoBot` (`bot.ts`): owns the Socket Mode connection and event routing. `app_mention` events are deliberately **ignored** — everything routes off `message` events (mention = text contains the bot id), killing the old dedupe problem.
  - `ThreadHandle` (`thread.ts`): `post` (Block Kit `markdown` blocks; files via `filesUploadV2`; per-message profile overrides, needs `chat:write.customize`), `postEphemeral`, `schedule`, `subscribe`/`setState`, `fetchMetadata`.
  - **Every message threads** — a top-level DM/channel message roots its own thread (`threadTs = event.thread_ts || event.ts`). `buildPrompt` scopes context to that thread only, so kyto has no memory of the rest of a DM by default; it uses `searchSlack` (`in:@user`) to pull earlier history on purpose.
  - Markdown conversion is ours (`harness/markdown.ts`): mrkdwn→markdown inbound, `healMarkdown` closes dangling fences in chunked replies. `bot.getState()` is an in-memory TTL KV (`harness/kv.ts`).

- **Custom agent loop** on `ai`'s `streamText` (`packages/ai/src/agent.ts` `streamAttempt` + `apps/bot/src/lib/agent/index.ts`): multi-step tool loop (`MAX_STEPS`, default **1000** — effectively no limit; the real bound is the watchdog, the degenerate guard, and a `skip`, since a hard cap stranded long jobs mid-solve). Per-attempt `@ai-sdk/openai-compatible` provider; a per-provider `fetch` tunes each request (see Models). `renderStream` (`lib/ai/stream/`) consumes `fullStream` and renders the plan.

- **Sandbox tools** (`lib/ai/tools/sandbox.ts`): `bash`, `readFile`, `writeFile`, `editFile` against `LazySandbox` (see "Sandbox / E2B" below).

- **Deferred tools**: uncommon tools (browser, email, canvases, reminders, sites, generateImage, focusMode, slackDocs, channel admin, pins, poll, askQuestion, mermaid, sendAsUser/editAsUser, gh, TTS, subagent, every MCP tool) are registered but hidden until the model calls the **`loadTools`** meta-tool, enforced per step via `prepareStep`/`activeTools`. **Whether deferral is worth it is MEASURED, not assumed**: every turn logs `[tools] turn summary` (`loaded`/`loadedUsed`/`loadedUnused`/`coreUsed`). Always-loaded-and-used belongs in `core`; a core tool never in `coreUsed` belongs behind `loadTools`; `loadedUnused` is a round trip paid for nothing. **Jev preloads** (`lib/ai/tool-preload.ts`; owner's ask 2026-09-29, from coolton): at turn start, in PARALLEL with the anti-coding check, one Jev call asks a yes/no per tool GROUP (browser, email, library docs, diagrams, …; ≥0.5 loads it, 3s timeout, a failure preloads nothing) and `built.preload` activates them before step one — never remembered for the thread, and never removes anything `loadTools` could reach. `preloaded`/`preloadedUnused` in the turn summary say whether the threshold is right.

- **Per-user MCP servers** (`lib/ai/mcp.ts`, `user_mcp_servers`): remote Streamable-HTTP servers added from **App Home**. **Plus built-ins for everyone** (`lib/ai/mcp-builtin.ts`): Context7 docs (owner's ask 2026-09-29), appended AFTER the person's own/shared servers so it steps aside for a user's own `context7`, its two read tools pinned `allow` and everything else `never`. Anonymous; `CONTEXT7_API_KEY` lifts the rate limit. **AgentMail's MCP on kyto's inbox** too (`AGENTMAIL_BUILTIN_ID`): reads and send/reply/draft/label open to all like the email tools, every result through `lib/email/redact` (the email invariant covers EVERY read path), `forward_message` and `get_attachment` hidden (forward sends the original server-side, around the redaction), inbox/delete/account tools hidden. A hand-rolled JSON-RPC client connects lazily per turn; listings cached 10 min; tools namespaced `mcp_<server>_<tool>`, deferred behind `loadTools`. A dead server degrades only that turn.
  - **The URL must be PUBLIC, checked twice** (`lib/ai/mcp-url.ts`, tested): once on save, once at CONNECT time with a DNS resolve, because a name that resolved publicly yesterday can resolve to `127.0.0.1` today. Without it, anyone could point a server at `169.254.169.254` or a neighbouring container and read the reply back out of their own Slack thread — the fetch runs from inside kyto's network and the response is printed. Do NOT relax this to a save-time-only check.
  - **A server can be SHARED with a channel or a channel group** (`mcp_server_shares`, `lib/ai/mcp-scope.ts`, owner's ask 2026-08-21). Anyone may share a server they own; the credential is NOT copied, the share points at the row. On a shared server the person SPEAKING approves an `ask`, not the sharer (owner's call — "person b can also approve it") — but a STANDING rule stays with the credential's owner, enforced in `features/mcp-permissions` (`gate.ownerUserId`) and the extra buttons are not even rendered for anyone else.
  - **Namespaces are resolved deterministically** (`resolveTurnMcpServers`, tested): the asker's OWN servers keep their names, a shared server colliding on a name is suffixed `_2`, and a server is listed once. Two people both calling a server `github` must never let one's call land on the other's credential — and the order must be STABLE, or the tool array reshuffles between turns and the thread's prompt cache is thrown away.
  - **A bare token is normalized to `Bearer <token>` at save time** (`normalizeMcpAuthorization`, tested), and a **failed listing is RECORDED, not just logged** (`getMcpFailure`, shown on the entry in App Home). One bug, two halves: the field wants a header VALUE but an API token is what gets pasted, so every bearer-auth server 401'd, and the old catch swallowed it — a bad entry looked exactly like a server with no tools. The record doubles as a 60s negative cache, since `buildMcpTools` is awaited while the toolset is built and a broken entry else added two 8s timeouts to every turn of that user's. The listing cache is keyed by URL **and** credential — on URL alone it served one user's listing to another.
  - **Every tool a server advertises is gated by that server's own rules** (`lib/ai/mcp-permissions.ts`, tested; owner's ask 2026-08-16). Each is classified `read`/`sensitive`/`write`/`unknown` (annotations → the ability its description STATES → name verbs; anything left stays `unknown` rather than being guessed into `read`), and each category carries `allow`/`ask`/`never`, with per-tool overrides on top. Defaults: `read: allow`, everything else `ask`. `parseMcpRules` falls back field-by-field to the SAFE shape, so a corrupt jsonb blob cannot open a gate. **Mechanics — classification layers, the shared add/edit modal, token replace/clear, pin syntax — are in [`.claude/TOOLS.md`](./TOOLS.md).**
    - **`never` means NOT REGISTERED**, not refused at call time (owner's call: "hide them entirely") — a hidden tool is unreachable by an injection and its schema never enters the prompt. The model is told only the COUNT per category, so it can say the category is off instead of confabulating a reason a tool it half-remembers is missing.
    - **`ask` blocks the call on a threaded ephemeral** (`lib/mcp-permissions/request.ts`, `features/mcp-permissions/`): Allow once / Always / Deny / Never, asking on **every single call** (no per-thread memory, owner's call). Only the row's `approverUserId` may click, checked BEFORE the row is claimed. There is deliberately **no DM fallback** — a prompt that cannot post refuses the call. `extendAttemptDeadline` holds the watchdog open for the wait, and an **unattended** run (a reminder, a subagent — no watchdog to extend) passes `unattended: true` to `buildTools` and gets a clear REFUSAL instead of a button nobody is watching.

### Channel groups

`channel_groups` + `channel_group_channels` — a NAMED SET OF CHANNELS so one
configuration covers several rooms (owner's ask 2026-08-21: "if many linked
channels, then i can link same mem and mcp with all 5-7 channels").

- **Anyone may create one** (owner's call); its creator is its custodian and only
  they (and the bot owner) may rename it, delete it, or change its channel list.
  That is checked at modal OPEN *and* at SUBMIT — the group id travels through
  the client, so opening someone else's group is one edited payload away.
- **A share follows the group.** Adding a channel to a group extends every MCP
  server and every promoted memory attached to it, so sharing with a group is
  trust in its custodian. The App Home copy says exactly that at the point of
  sharing; do not quietly make it read like a snapshot.
- **Deleting a group takes its dependents with it** — MCP shares dropped,
  scoped memories demoted to private. An orphan fails closed (it resolves for no
  channel) but is also invisible and impossible to revoke, which is the worse property.
- Resolved ONCE per turn in `buildTools` (`listGroupIdsForChannel`) and reused by
  both the memory scope and the MCP toolset.

## AI tools

Tools live in `apps/bot/src/lib/ai/tools/`, registered in `lib/ai/toolset.ts`. Raw Slack API: `slack.webClient.apiCall(method, args)`; error helpers from `@/lib/utils/error`. **`TOOLS.md` is the index of the roster**; don't duplicate it here.

### Skills

`loadSkill` (core) / `manageSkills` (OWNER-only registration) — `lib/skills/`, `skills` table (owner's ask 2026-09-29, from coolton). Built-ins are the `.md` files in `apps/bot/src/skills/` (read at boot; a bad one fails the boot), the owner's rows add or override by name. **The index is `loadSkill`'s DESCRIPTION**, sorted by name — tool schemas are in the cached prefix, so a stable order matters and only a catalog change moves it (60s cache). **Writing a skill is owner-only for the same reason a memory needs promotion**: it is prompt text every user's turn loads. Install is by GitHub link only (`githubSkillSource`, tested — https github.com/raw.githubusercontent.com, no `..`), anonymous, SKILL.md + `references/*.md`. Third-party skills with NO licence (the AgentMail pack) live only in the DB, never in this public repo; coolton/gorkie ports keep their AGPL attribution line.

### Kevinton — the silent reviewer

`lib/kevinton/`, `kevinton_reviews` (owner's ask 2026-09-29, from coolton; `KEVINTON_ENABLED` kill switch). Every finished non-`!secret` turn in a **channel, public or private** (owner's call; never a DM or group DM) pushes the thread's review 30 min out; a 60s poller CLAIMS due threads atomically (tested against the DB: concurrent claims → one) and runs a full, headless kyto turn on `subagentAttempts` (GLM 5.3 on Hack Club first — the shared chain, owner's call). Load-bearing:
- **It never speaks in the thread**: its toolset is an allowlist of LOOKING tools (`LOOKING_TOOLS`) plus its own two; it runs as a synthetic non-owner (`kevinton`), `secret: true`, `unattended: true`, in a throwaway sandbox.
- **Issues go straight onto the PUBLIC `Devansh-awat/kyto`** (owner's call) as `kyto-agent`, titled `[kevinton] …` (no triage access for labels), DETAILED (what happened / what kyto was doing / evidence / likely cause with code paths / fix / repro); IMPROVEMENTS too, not just defects (owner's ask 2026-10-05: what prompted it / today / proposal / why it is worth it, titled `[kevinton] improvement: …`), search-before-file, ≤2 per review and ≤20 per day (counted on GitHub, so it survives restarts). Never a comment on a CLOSED issue (nobody sees it): a recurrence of one closed as fixed is `reopen`ed with the evidence through the owner's `KEVINTON_REOPEN_TOKEN` (only that PATCH uses it; the comment is still kyto-agent's), closed-as-not-planned is left alone, and with no token set it files "Recurrence of #N". Conversation content may go in (owner's call); secret values go through `redactSecrets`.
- **It reads kyto's logs through the owner's App Home Coolify MCP** (`KEVINTON_LOGS_MCP`, default `coolify`), with `LOGS_RULES` FORCED over that entry's own: reads + `get_logs`, never deploy/control/cancel/env names — the token behind it can restart kyto. Container logs start over at every redeploy, so an older turn is often out of reach. Source comes from the codeload tarball (git through the sandbox's GitHub proxy fails for its identity).
- **Skills it proposes go to the owner's approval queue** (`kind: 'skill'`, posted in the owner's DM, re-parsed at execute) — never live on its own say-so. It never opens PRs or changes code (coolton's does; kyto's files issues instead).

### Per-tool detail lives in [`.claude/TOOLS.md`](./TOOLS.md)

Read it before touching a tool. **Not loaded automatically** (same convention as MODELS.md), so the security invariants below stay here.


## Sandbox / E2B — lazy, and persistent per thread

Config in `packages/sandbox/src/config.ts`. E2B backs the `bash`/file tools and the host tools that opt in (`browser`, `deploySite`, `getFile`, `uploadFile`).
- **Lazy** (`LazySandbox`): `Sandbox.create` is deferred until a tool touches it, so chat-only turns cost zero E2B.
- **Persistent per thread**: `destroy()` **pauses** rather than kills, the thread's `sandbox_id` is remembered in `thread_sandboxes`, and the next turn calls `Sandbox.connect(id)` (auto-resumes, ~450ms) for the same filesystem. This makes a **`bash` recurring reminder** useful (write/test a script, then schedule it) and is what `wait`'s `pauseSandbox` leans on.
  - **Created with `lifecycle: { onTimeout: 'pause' }`** — E2B's default KILLS on timeout, and a restart (the old process never pauses) or a turn idle past the timeout wiped the thread's files three times in one thread on 2026-10-03. `run()` refreshes with `sandbox.connect({ timeoutMs })`, which also resumes a box that auto-paused mid-turn. A box E2B reports GONE at that point (killed mid-turn) is forgotten and a fresh one created, with a note in the command's output that earlier files are gone — the held handle used to fail every later command for the rest of the turn (#26). **E2B stops a sandbox after 1h of continuous running (Hobby; pause+resume resets it)** — that was #26's real cause (a 64-min turn). So `run()` pauses and resumes a sandbox that has run >50 min (owner's number) before its next command, unless a command is in flight on it; the clock (`runningSince`) and the in-flight count are per SANDBOX id, since both kytos in a thread share one sandbox. Sandboxes created before the fix keep the kill default.
  - **The persistence details — the `SandboxStore` injection, a thread vs a "conversation", stale create-time `envs`, the per-thread lock, the 30-day activity reaper, and the ONE shared virtual display — are in [`.claude/TOOLS.md`](./TOOLS.md).**

- **Memory = the Slack thread.** `buildPrompt` feeds the whole thread (`slack.fetchMessages`, capped); no verbatim TRANSCRIPT is persisted. kyto DOES persist three kinds of DERIVED text — `thread_thinking`, `thread_summaries` (~30-day retention) and `memories` (until deleted) — all of which can paraphrase message content. Deliberate: the owner signed off and cleared it with Hack Club. Full position in `docs/reference/security.md`.
- **…plus the last few turns' THINKING** (`lib/agent/thinking.ts`). Slack records only what kyto *said*, so without this every turn re-derived the previous turn's conclusions. `renderStream`'s `onReasoning` collects it; `rememberThinking` keeps the last 3 turns per thread, injected as `<your_previous_thinking>`. **Persisted** (`thread_thinking`, ~30-day retention, daily `startThinkingReaper`) so it survives a restart. Only the attempt that ANSWERED leaves its thinking, so a spiral can't seed the next turn.
- **…plus a COMPACTED digest of whatever no longer fits** (`lib/agent/compaction.ts` + `compaction-plan.ts`, `thread_summaries`). `buildPrompt` replays the newest `MAX_THREAD_MESSAGES` (100) verbatim — and at most `MAX_REPLAY_CHARS` (240k, ~60k tokens; owner's ask 2026-09-29, the one thing coolton's token-sized compaction did better), the start moving in steps of 25 so the cached history prefix rarely shifts (`replayWindowStart`, tested) — and folds everything older into a running summary injected as `<earlier_in_this_thread>` — past the cap, messages used to just vanish and the model contradicted decisions it could no longer see. **The block ALWAYS states the count**, summary or not. Runs on `subagentAttempt` (the Gemini key), NOT the HackClub cap. Reaped by `startSummaryReaper`; erased like `thread_thinking`.
  - **The READ is incremental, which is what makes "the whole thread" affordable** (2026-08-08). The fetch starts at the digest's `throughMessageId` (`fetchMessages`'s `oldest`), so history is read ONCE and later turns cost the replay window. Ceiling `MAX_HISTORY_MESSAGES`/`MAX_HISTORY_PAGES` (20k): Slack only pages a thread FORWARD, so a never-compacted thread costs one call per 1,000, and a returned `nextCursor` means the tail was NOT reached.
  - **A truncated walk RE-ANCHORS near now and skips compaction that turn.** A leftover cursor means the walk stopped mid-thread, so replaying its last 100 would hand the model a conversation from months ago as if it were live (measured: `slack:C06QV2T1P4G:1710818631.730789` is 25,000+ messages). It re-reads from a week before the current message and renders `renderUnreadableBlock` (no count: kyto doesn't know what it didn't see).
  - **The boundary is found by TIMESTAMP, not by index** — an incremental read never contains the older ids, and `conversations.replies` prepends the thread root to every page, so an index lookup calls the digest "unlocatable" and rebuilds it from scratch.
  - **A backlog is CHUNKED into passes that each extend the previous digest and each PERSIST** (`MAX_MESSAGES_PER_PASS` 200); it used to clamp to the newest 200 and move the marker past the rest, losing them permanently. >1 pass runs in the BACKGROUND (one per thread, `catchingUp`) so a months-old thread never stalls a reply.

