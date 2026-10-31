# Code standards

**Ultracite** (a Biome preset) enforces formatting and lint. Run `bun x ultracite fix` before committing; `bun x ultracite check` to lint. It auto-fixes most style issues, so spend your attention on business-logic correctness, naming, architecture, edge cases, and UX.

House style beyond Biome: explicit types where they aid clarity, `unknown` over `any`; `const` by default; `for...of` over `.forEach()`; early returns over nesting; named constants over magic numbers; `Error` objects with real messages; no `console.log`/`debugger` in production; no barrel files; validate input.

Also: inline over extract (no one-shot helpers, wrappers, or re-export-only
files); a function with more than one parameter takes a single options object;
never cast to silence TypeScript — parse or validate with Zod at the boundary;
comment only a non-obvious *why*, especially the failure the code exists to
prevent; Slack features live under `apps/bot/src/features/<name>/`, and nothing
Slack-only goes in `packages/ai`.

**Before handing work back:** `bun run typecheck`, `bun run check`
(`check:write` autofixes), `bun test`, plus `bun run check:spelling` and
`bun run check:knip` for cleanup or package-export work. New tables and columns
go in as one-off `ALTER TABLE … ADD COLUMN IF NOT EXISTS` /
`CREATE TABLE IF NOT EXISTS` SQL — `drizzle-kit push` prompts interactively and
hangs in a non-TTY shell.

`AGENTS.md` at the repo root is a symlink to this file, so any agent that reads
`AGENTS.md` (agy/Gemini, Codex, …) gets exactly these instructions.

---

# Project Notes (Kyto Slack bot)

> **Keep this file current**: update the relevant note in the SAME change as the
> feature (tool, scope, flag, gating rule). Stale notes are worse than none.
>
> **Keep this file under 40k characters** (Claude Code warns past ~40k, and its
> docs: "longer files consume more context and reduce adherence"; owner's call
> 2026-10-26). Only rules that apply to EVERY change live here. Area detail goes
> in a path-scoped rule (`.claude/rules/<area>.md`, `paths:` frontmatter), which
> loads only when matching files are touched; a new area gets a new rule file.
> Keep notes to the durable *what and why* — delete post-mortem narrative.

> **Build features FULLY, not minimally.** A new tool isn't just its happy path —
> think through creation, editing, removal, listing, ownership/permission gating,
> persistence across restarts, and how the model manages it. If a dimension
> shouldn't exist, say why; don't silently omit it.

> **Check `TODO.md` when touching related files.** If an open item lives in the
> area you're editing, tell the user and offer to fold it in. Remove resolved
> items from `TODO.md` in the same commit.

> **Delegate the reading to subagents; keep the editing yourself.** Searching a
> big surface burns the main context on output you only need the conclusion of.
> Do the edits, the judgement calls, and the security-sensitive reasoning in the
> main thread. Run independent investigations in parallel. Never delegate away a
> decision this file says is load-bearing.
>
> **Be token-conservative — it is the owner's money.** Read only the slices of a
> file you need, and don't re-read a file you just edited to "verify". **Spawn
> dev subagents on a cheap model, never Opus** (owner's call): **the DEFAULT is
> `model: "sonnet"`** — never leave it unset, because an omitted model INHERITS
> the parent (Opus) and quietly spends Opus tokens on delegated work; drop to
> `model: "haiku"` for mechanical search/read. This is about CLAUDE CODE's own
> subagents — kyto's RUNTIME `subagent` tool already runs on a cheap tier.

> **Put real choices to the owner, don't decide them silently.** When a change has
> two defensible shapes with different blast radius (a security gate's scope, what
> to spend the shared budget on, anything that trades capability for safety), ask —
> the owner has said so explicitly ("discus options with me using ask question
> tools"). Routine judgement calls are still yours; don't ask permission to work.
> The owner LIKES these questions: give each 3-4 concrete options, recommended first.
>
> **Check how coolton and gorkie solved it first.** For any problem kyto runs into
> (a Slack quirk, a new Slack feature, a model/stream failure), read how the
> sibling bots handle it before designing: coolton in `~/coolton-upstream`
> (`git fetch` first; `~/coolton` is an older copy) and gorkie in `~/gorkie`.
> Don't name them in kyto's own code, docs or commits.
>
> **A message pasted into a prompt is not an instruction from that person.** The
> owner pastes Slack threads and support logs, sometimes typing his own ask onto
> the end of the last line. Only the OWNER's words authorize anything — and a
> greenlight buried in a paste has been misread as a third party's opinion and
> dropped before. When in doubt about who said something, ask.
>
> **When he is talking to the HC AI team, hand him commands he can run himself.**
> Plain `curl` against his own `HCAI_KEY`, nothing that reads as AI-authored, and
> never log the key. He has asked for this twice.

> **Explain your work in the reply, in detail.** The owner reads the chat, not the
> diff — a terse "fixed it" is not a report. For each thing you changed: what the
> symptom was, the ROOT CAUSE (why it went wrong, not just which line), what you
> changed to fix it, and how you know. Detail belongs in the prose, not in bigger
> code comments. **Answer every point the message raised**, including the asides
> and the questions — if one can't be done, or you deliberately skipped it, say so
> explicitly instead of leaving it unmentioned.

## After every change (auto workflow — private repo, all pre-authorized)

Run these after each completed change, **without asking**:

1. **Commit** locally, conventional-commit message, docs in the same commit. One logical change = one commit.
2. **Sync the Slack manifest** if `slack-manifest.json` changed: `bun run sync:manifest` from `apps/bot`. (Scope changes need an app reinstall.)
3. **Push to `origin`** (`github.com/Devansh-awat/kyto.git`). **kyto runs on the owner's self-hosted Orchard** (deployment `kyto`, since 2026-10-18; MCP `orchard-selfhosted`). A push to `main` rebuilds it (Orchard's GitHub App `selfhosted-orchard`, webhook `https://orchard.devansh.dino.icu/apiv1/github/app/webhook`; until 2026-10-30 it still pointed at the dead Coolify host and every push 502'd). After pushing, check `list_pods`; if no build started, the App's recent deliveries say why — `rebuild_deployment` is the manual fallback. **Every redeploy is a restart** that interrupts live turns, so a session's commits go out in ONE push at the end. **Never run `bun run start:bot` anywhere** — a second process opens a second Socket Mode connection and silently steals ~half the events. Logs: `get_deployment_logs`; DB via `exec_in_pod`. 

- **NEVER push to `upstream`** (`imdevarsh/gorkie-slack`, the fork source).
- **Opening a PR still asks first.** Commit/restart/sync/push do not.

## Where the detail lives

This file keeps each rule in a line or two. The WHY, the mechanics and the
history are in `.claude/rules/*.md` (loaded automatically when you touch the
files each one names) and in files that are NOT loaded automatically — read the
relevant one before touching its area, and update it in the same change:
[`GATING.md`](./GATING.md) (security invariants + identity/gating, full text),
[`TOOLS.md`](./TOOLS.md) (tool roster, sandbox, MCP, architecture),
[`MODELS.md`](./MODELS.md) (routing), [`STREAMING.md`](./STREAMING.md)
(rendering), [`OPS.md`](./OPS.md) (deploy, manifest, DB, dashboard).

## Architecture — fully custom harness

No Chat SDK / Pi / `@ai-sdk/harness*`.
- **Slack harness** (`apps/bot/src/harness/`, Socket Mode only): `SlackHarness` (thread-id codec `slack:CHANNEL[:TS]`, fetch/history, native streaming via `chatStream` with task cards), `KytoBot` (event routing — `app_mention` is IGNORED, everything routes off `message` events), `ThreadHandle` (`post`/`postEphemeral`/`schedule`/state). **Every message threads** (`threadTs = thread_ts || ts`); `buildPrompt` scopes context to that thread. Markdown conversion is ours (`harness/markdown.ts`).
- **Agent loop** on `ai`'s `streamText` (`packages/ai/src/agent.ts` + `apps/bot/src/lib/agent/index.ts`), `MAX_STEPS` 1000 — the real bounds are the watchdog, the degenerate guard and `skip`. `renderStream` renders the plan.
- **Deferred tools**: uncommon tools and every MCP tool hide behind `loadTools` (`prepareStep`/`activeTools`). Deferral is MEASURED (`[tools] turn summary`). **Jev preloads** tool groups at turn start (`lib/ai/tool-preload.ts`, on the FULL thread as kyto sees it minus plan cards, `buildPrompt`'s `jevConversation`, newest 100k chars; started once the thread is read, awaited after the tools build; ≥0.5, 3s, failure preloads nothing, never removes anything; a preload is REMEMBERED for the thread like a `loadTools` (both, and the tool order, survive a restart in `thread_loaded_tools`), because a tools array that differs between turns throws the whole cached thread away). No forced first tool call (owner's call 2026-10-17). The procedure and a Hack Club channel directory live in `corePrompt`.
- **Per-user MCP servers and channel groups**: `rules/mcp.md`. Load-bearing: the URL must be PUBLIC (checked at save AND connect); `never` = not registered; `ask` = the approver's click every call.

## AI tools

In `apps/bot/src/lib/ai/tools/`, registered in `lib/ai/toolset.ts`; `TOOLS.md` is the roster.
- Tool families, `todo`, the repeat cache, workspace files, skills: `rules/tools.md`.
- **Kevinton** (silent reviewer, files issues as `kyto-agent`, keeps notebooks), **code channels**, the **live browser view** and the owner-only **Slack browser**, and **the coding agent**: `rules/kevinton.md`, `rules/code-channels.md`, `rules/browsers.md`, `rules/coding-agent.md`.

## Security invariants (do NOT regress) — full text in [`GATING.md`](./GATING.md)

- **Code Mode / the sandbox can't invoke mutating tools**; no host-tool RPC bridge without a confirm gate.
- **`getFile` sends the bot token ONLY to Slack hosts** (`isSlackFileHost`). No arbitrary-URL passthrough.
- **Secret VALUES are scrubbed on the way out** (`lib/redact.ts`; tool results in `trackUse`, everything to Slack via `harness/outbound.ts`), owner DM'd the NAME only. A backstop, not the defence. The GitHub proxy attaches the PAT only when `mayCarryPat` says https + `api.github.com`/`github.com`/`uploads.github.com`.
- **The bot token never enters the sandbox**; Slack is reached only through the host-side READ-ONLY proxy (`lib/slack-proxy/`). `fetchUrl` refuses `*.slack.com`.
- **NO GitHub credential in a sandbox; the write gate is the HTTP proxy** (`lib/github-proxy/`). Never a `network` rule carrying the token. Command-text guards are UX, not the boundary.
- **GitHub writes are gated on repo ownership** (`github_repos`): claimed repos writable by claimant/editors/owner only; detached commands checked at START; claims only on success, never for third-party repos. **Third-party writes need owner trust** (`github_trust`), except a repo that added `kyto-agent` as a push collaborator — and except **contributions** (a PR, issue or comment; owner's call 2026-10-11), which the PROXY vets instead (`lib/github/contributions.ts`, `github_contributions`): per-user + global daily caps, per-repo open limits, a maintainer's `spam` label or a run of closed-unmerged PRs stops it, a model review against the repo's CONTRIBUTING/templates/AI policy refuses with reasons (counts toward the cap), and a host-side footer discloses the AI and names the Slack user — never their email (GitHub's AUP forbids posting personal info without consent). The input must come from `$input` with one top-level field (an inline second body would dodge the review). **kyto's forks are shared**: a non-claimant may push only `refs/heads/<slack id lowercased>/…` (refs read from the push's pkt-lines, `push-refs.ts`). **Forking (`POST /repos/{o}/{r}/forks`) is NOT gated** (owner's call 2026-10-08): the proxy classifies it as a self-create, and re-forking a repo whose shared fork already exists passes the shared-fork rule (it changes no refs); a fork redirected into another org (`organization` body) stays a normal third-party write.
- **Every shell carries BOTH controls** — GitHub guard + `disarmFetchedRepos`. SIX shells: `bash`, `gh`, `codeMode`, `runBackgroundProcess`, `slackScript`, `codingAgent` (the last two disarm unconditionally, as does a `bash` reminder). Every repo materialization runs `GIT_HARDEN_COMMAND`.
- **A saved memory is PRIVATE until the owner promotes it** (global, channel or group); promotion transfers custody; a caller that forgets the scope gets LESS. kyto saves memories proactively; the `<memories>` block renders even when empty. **Weekly curation** (`lib/memory-curation`, owner's ask 2026-10-08): one flex model call proposes merges/removals of someone's PRIVATE memories (≥8 changed); `checkPlan` keeps only safe ones (own ids, removals >30 days old, ≤20%); merges are joined by CODE. Every change is snapshotted in `memory_curations` (erased with "Your data"); the `memory` tool's `restore` brings one back; the person's `<memories>` block mentions the week's tidy-up — never a DM. **A memory may carry a folder** (`memory_files`, ≤5 MB gzipped, cascade-deleted with it; owner's call 2026-10-09): `attach` / `files` (unpack, into an EMPTY folder only) / `detach`, same write rule as `edit`; `.git` and `node_modules` never stored or unpacked (a `.git` would be an unhardened repo); curation skips such memories (a merge would drop the folder); the dashboard lists the files before a promotion.
- **Anyone can erase their own data** (App Home "Your data"); shared-channel reasoning and promoted memories are REPORTED as surviving, never papered over. Sandboxes killed at E2B before rows drop.
- **Email read paths strip reset links and codes, owner included** (`lib/email/redact.ts`) — every read path, the AgentMail MCP's results too — except a turn whose OWN message from the owner carries `--no-redact` (one turn, harness-read, never subagents/reminders/Kevinton; stored observations re-redacted). Its `forward_message` is the one owner-accepted hole.
- **Broadcast pings are DENIED BY DEFAULT** in `ThreadHandle.post`/`schedule` (`allowBroadcast`); only the owner's streamed reply and an owner's same-channel `postMessage` opt in. `webClient` direct posts bypass it — `poll` neutralizes itself.
- **The approval gate** (`approval_requests`): persisted, public, never expires; card in the owner's DM when the owner can't see the thread (#40); only the owner decides; the action runs from the row written at REQUEST time; `kind` is a CLOSED set (`post`/`broadcast`/`github`/`skill`) re-validated at execute; claim is `status = 'pending'` in the UPDATE. **`sendAsUser`/`editAsUser` must never become an approval kind.**
- **kyto's USER-account session** (`KYTO_USER_TOKEN`/`KYTO_USER_COOKIE`, an `xoxc-` + `d` cookie of kyto's own member account `U0BSJ6ZGNDQ`, not the owner's) is env only, never DB/sandbox/log, and reachable only through `addEmoji`/`removeEmoji`, `postMessage`'s `fromUserAccount` (EVERY postMessage gate first), `pinMessage`/`unpinMessage` with `as: 'account'`, the user-account persona's own replies + reading back the thread it was pinged in, `searchSlack` (asker-membership filtered), the owner-only thread-cleanup shortcuts (deleting the account's OWN messages only), and the owner-only `slackBrowser` through its loopback proxy (cookie added and token swapped outside the browser; the page only ever sees a dummy). The harness marks that account's messages `isMe`, or kyto answers its own posts — except the APP answers the account's explicit @mention of it, gated as a bot's ping (one way only, so no ping-pong). No general "call Slack as that account" helper — `fetchMessages`'s `asUserAccount` is for the persona's own thread, never a tool.
- **Only `/embeds/` is frameable**; only `kyto.dino.icu` unfurls. **Every hosted site/embed is served `CSP: sandbox` (opaque origin)** — they share the origin with `/_dashboard`, so a page's script could otherwise read its CSRF token and post as the owner. Only kyto's own `/embeds/live-*` frames are exempt (noVNC needs storage); the embed tool refuses that prefix. Whiteboards are Excalidraw with our own sync; a socket needs a board kyto published. **tldraw is banned** (licence).
- **Event reminders** (`lib/reminders/events.ts`): a Slack trigger needs kyto in the channel and the creator able to read it, re-checked each fire; a webhook URL is a key, shown only in a DM. Detail: `rules/reminders.md`.
- **Reminders and sites**: editable by creator, named editors, owner. **An editor may retime a reminder, not change what it RUNS** (`kind`/`command`/`url` are creator/owner only) — it fires as its creator.
- **A message lands mid-turn → it interrupts only if it is for kyto** (`lib/agent/addressed.ts`, #27): a ping, a DM or a wake always does; anything else is put to Jev, which reads the thread's newest 12 messages (kyto's replies included) around it (≥0.3, fails OPEN, never a `!secret` text); a "no" only means don't interrupt: the latest such message gets its own turn when the running one ends by itself, as if kyto had been idle. The author's OWN follow-up is FOLDED IN on the next tool result (`steerTurn`), else interrupts after 30s; anyone else's interrupts (GATING.md). After 3 min of tool cards with no text, the next tool result asks kyto to say what it's doing (`takeReminder`).
- **An interrupt burst merges only within ONE author** (`steering.ts`) — else a stranger's text ran as the last speaker, possibly the owner.
- **A non-owner's `postMessage` never starts a top-level message**; same-channel goes into the invoking thread. `setChannelTopic` follows the same rule.
- **Kevinton never posts in a thread and never runs as the owner** (`KEVINTON_USER_ID`): the GitHub guard refuses its shell writes before any approval card, and `requestApproval` throws for it — its turn's thread is the one it reviews (#136). What it files is public, so secret values are redacted.

## Identity, gating, and etiquette — full text in [`GATING.md`](./GATING.md)

- **Broadcasts are owner-only and channel-local** (`neutralizeBroadcast[Deep]`, applied cross-channel even for the owner). A control mention renders as `section`+`mrkdwn` (the `markdown` block doesn't resolve it); an allowed APP broadcast goes out in a legacy attachment, then is `chat.update`d clean (#150, GATING.md).
- **`postMessage`**: optional Block Kit `blocks`; **identity override is OWNER-ONLY** (`lib/post-identity.ts`); **wearing a real person's face needs THAT PERSON's yes**, even same-channel. **Cross-channel posting is owner-gated** (a non-owner DM goes to the confirm gate — except a DM to the person who asked, sent at once, owner's call 2026-10-02). **Pins** name the actor: `app`, `account` (kyto's user account; the default in its own turns) or `owner` (owner-triggered turns only) — `'user'` once meant the owner and pinned under his name. `sendAsUser`/`editAsUser` are registered for the owner only and re-check at execute.
- **Outward posts need a confirm click** (`lib/confirm-post/`): cross-channel/DM posts (not a DM to the requester themself), a mirrored face, every send/edit-as-owner. The clicker is checked against `approverUserId` BEFORE the row is claimed.
- **A non-public conversation is read from elsewhere only for its members** (`lib/slack/channel-access.ts`): the read tools and the sandbox Slack proxy both check the ASKER's membership. A DM or private channel the bot can't read is read by `readConversationHistory` with the ASKER's own token (`askerSlackToken`: their OAuth grant, or `SLACK_USER_TOKEN` for the owner only) — exactly the conversations they are in; no click per read (owner's call 2026-10-05).
- Linked canvases and `searchSlack` (asker's own token first; kyto's account's hits kept only from channels the asker is in): `rules/slack-reads.md`.
- **Channel instructions** (`features/channel-instructions`, `channel_instructions`): App Home, set by the channel's CREATOR (`conversations.info`, checked at modal open AND submit, fails closed on a channel kyto can't read) or the owner; live at once on EVERY turn there, the owner's included (owner's call 2026-10-09). Rendered as `<channel_instructions>` at the front of history; the speaker's own instructions win; erased with "Your data" settings.
- **Opt-in** (`OPT_IN_CHANNEL`): "i accept" (joins) or "i accept, but don't add me" (`opt_ins` table — the allowlist is otherwise rebuilt from membership at boot). `@kyto!optout` withdraws.
- `!commands`, CLI flags, thread clean-up, **bans (the model has no ban tool)** and moderation (never blocks or bans): `rules/commands.md`.
- **Anti-coding**: coding-agent work never runs on Hack Club AI's shared key; it goes to the `codingAgent` tool (Crush), silently. Making or editing a FILE stays in bash. Detail: `rules/coding-agent.md`.
- **`!secret`**: question deleted with the asker's OWN token BEFORE the model runs, answer is one ephemeral with no DM fallback, no `thread_thinking`, no Kevinton review, no live view, no tool that posts or acts visibly in Slack (`PUBLIC_POSTING_TOOLS` in `toolset.ts`), the question and tool I/O kept out of logs, and a failure told ephemerally. No connected account → refused with a link.
- **Per-user Slack OAuth** (`lib/slack-oauth/`): needs `BYOK_ENCRYPTION_KEY` + client id/secret; ciphertext only; the `state` is ENCRYPTED and carries the user id; no public `start` route.
- **`<>` at the front** = answer only if kyto is mentioned in that message (the message stays in context). **`##` at the front** = invisible to kyto (skipped AND filtered from history; only the first content line counts; `~## …~`/`*##`/`_##` formatting in front counts too; `##lol` arrives as `#<#G…>` when `#lol` is a channel, and counts too) — except KEVINTON, which reads them (marked) in the replay window only, never into the shared digest (owner's call: complaints go there). **Pulled in partway**: an unpinged reply in a thread whose root neither pinged nor was posted by this kyto gets a "reply only if needed, else skip" line (`pulledInLater`, `prompt.ts`).
- **Joining**: a human's mention ANYWHERE in a thread (not just its top) subscribes that thread. A reply Slack refuses with `not_in_channel` joins the (public) channel and retries, then goes out from the user account (`reply.ts`, owner's call 2026-10-02).
- **The user-account persona** (answers as kyto's account, one kyto per thread) and **channel pairing**: `rules/user-account.md`.
- **Other bots** are answered on an explicit @mention — or, in a thread kyto follows, when kyto @mentioned that bot there in the last hour — ≤50 bot turns in a row per thread (owner's number; 15 min, reset by a human), and at the cap kyto says once that it stopped automatically; no DMs, no auto-join, no opt-in gate, bans apply. `harness.botId` marks kyto's own `bot_message` posts `isMe` — lose it and kyto answers itself.
- **No channel-join greeting, ever** (kyto was banned for one). **kyto speaks only when invoked.** The one exception is the line `joinChannel` posts when someone ASKED kyto to join, naming who asked (owner's call 2026-10-31): it is accountability, not a greeting.
- Display name `kyto` (`U0BD3555UCQ`, app `A0BCA6D6GAV`), handle `kyto2` (`kyto` is the user account's; `annotateMentions` special-cases it). **Owner grounding** (`RequestHints.ownerUserId`) stops kyto confabulating its origin.
- **AGPL-3.0, PUBLIC repo** `github.com/Devansh-awat/kyto`; gorkie-derived code MIT (`LICENSE-gorkie-MIT`). Never point anyone at `imdevarsh/gorkie-slack` as kyto's source.
- **Identity profiles** (`identity_profiles`, App Home "Identity"): icon only; the name is only ever "kyto" / "kyto subagent[ name]".

## Response style and the plan UI

- Write like a human in Slack (`prompts/personality.ts`); kyto MAY narrate in-between updates.
- The agent loop's tested modules, the plan UI, message layout, reply footer: `rules/streaming.md`.

## Models / fallback — full detail in [`MODELS.md`](./MODELS.md)

- Primary haiku 5.5 on Hack Club AI (Anthropic-pinned), Jev picks the effort; routing, caching, BYOK, resumed turns and spend: `rules/models.md` + `MODELS.md`.
- **`LEADERBOARD_FALLBACK` is CHEAP ON PURPOSE** — one $3/day cap. Price any new rung first. Fallback walks by TIER, best-first (`buildFallbackQueue`, an ALLOWLIST of tiers). **No provider whose terms allow training on inputs may be a tier** (Hack Club forbids training on Slack).

## Sandbox, memory, compaction

- **Memory = the Slack thread** (derived text only: `thread_thinking`, `thread_summaries`, `memories`); a private turn is replayed only on its speaker's turns. Logs, E2B, thread cache, revisions, compaction: `rules/memory-context.md`.

## Operations — in [`OPS.md`](./OPS.md)

Read it for the manifest/scopes, anything deploy-shaped, "kyto isn't responding", new tables, or the owner dashboard. Two rules stay here: one password guards the dashboard (constant-time compare, global lockout after 8 failures, per-session CSRF), and **approving a queued GitHub request grants trust and stops there** — it never replays the command.
