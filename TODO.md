# Kyto TODO

## When something is done, remove it from here
## how this works: i put my ideas, problems, etc here, then every 2 or so days i ask claude(you) to fix it. 

### Open

**Move the GitHub write gate to the HTTP layer** — owner's call, 2026-07-29
("yeah move gaurd to http layer"), and it was never recorded or built. The
trigger was the owner's own question: "if you get a shell into kyto, you can use
its gh and do stuff right? … remote shell are not easy to stop, you block sshx
one will use tmate". He is right, and the token being unextractable does not
help: the E2B egress rule staples `Authorization` onto EVERY github.com request
out of the sandbox, so any process in the box — kyto tool or not — is already
authenticated as `kyto-agent`. `guardGithubCommand` only ever sees strings that
came through a kyto TOOL, so sshx/tmate, a shell script, or `sh -c 'g''h …'`
never meets it.

The intended shape: kyto's own host-side proxy in front of GitHub (the pattern
`lib/slack-proxy/` already proves), enforcing on the PARSED request —
`POST /repos/o/n/pulls` is unambiguous where a shell string is not. Reads pass,
writes checked against `github_repos`/`github_trust`, every request logged with
thread + user for attribution.

**Blocking constraint, measured 2026-07-30:** E2B rules can only INJECT HEADERS
(`SandboxNetworkTransform` is `{ headers }`) — they cannot redirect a host. So
the proxy cannot be slipped in transparently. It needs all three of: stop
brokering the token; point the sandbox at the proxy (`GH_HOST`,
`git config url.<proxy>.insteadOf`); and **`denyOut` the real GitHub hosts** so a
shell can't bypass the proxy by curling github.com directly. That last part is
the owner's "credentials XOR open network" idea arriving by necessity, and it is
the piece that needs a decision: a deny-list only for GitHub hosts is cheap, but
a full deny-by-default allowlist (the version that actually kills remote shells)
would also break the browser tool, arbitrary `fetch`, and npm/pypi from
unexpected hosts. **Decide the blast radius before building it.**

Adjacent, from the same conversation and also unrecorded:
- A **GitHub App minting per-turn installation tokens** scoped to the repos the
  guard would allow is the durable answer — it also fixes the "kyto has ONE
  GitHub identity" problem that got the PAT revoked in the first place.
- A **hard wall-clock ceiling per sandbox**, independent of activity. The reaper
  is activity-based, so a sandbox kept warm never ages out (the owner's own "if
  you get kyto to use wait and not pause sandbox?").
- DONE 2026-07-30: `runBackgroundProcess` was a fourth, ungated shell —
  `runBackgroundProcess("gh pr create …")` walked past the ownership check that
  the identical `bash` command hits. Now gated at start time, and refused
  outright when there is no principal to attribute the write to.

**Reduce the system prompt.** Asked 2026-07-28 ("maybe reduce system prompt
too", in the same message as the Qwen pin and the caching work) and never
attempted — the other three parts of that message shipped. Measure the assembled
prompt first; it is paid on every turn of every thread against the shared $3/day.

**Going public: every licence QUESTION is answered; one mechanical task is left.**
Gorkie provenance is MEASURED (2026-07-26, blame-based, in
`docs/reference/publishing.md`): ~16% of runtime source is gorkie-derived, so the
MIT carve-out stays. `ai-sdk` is RESOLVED (2026-07-29) — `vercel/ai` is
**Apache-2.0**; GitHub's "Other" was wrong. Redistribute with the notice "This
software contains components from Vercel's AI SDK, licensed under Apache License
2.0. Copyright 2023 Vercel, Inc." `thermo-nuclear-code-quality-review` was
**dropped** (2026-07-29) — unverifiable licence, nothing depended on it.

Licence work is DONE (2026-07-29): every third-party skill now ships its upstream
`LICENSE`. Secrets rescan is DONE: no kyto credential anywhere. The netic
third-party key in history is NOT a blocker — Netic confirmed it is revoked and
consented to it being public. Remaining before the flip is only: update
`packages/ai/src/prompts/slack.ts` (it still says kyto is private with no public
repo — false the moment the repo is public), done in the SAME commit as the
visibility change.

Rotating `GH_TOKEN` is NOT a publication task. Publishing cannot leak it: no
credential is in the tree, and Slack messages are not in the repo. Rotate it on
its own schedule if it was ever pasted into a thread or a log.

**"Thinking..." shows as plain text before the plan block appears**, and when
the block does appear it already has thinking in it. Investigated: no such
string exists anywhere in kyto, and the first plan chunk is already pulled
before the stream opens, so this looks like Slack's own placeholder for an open
`chatStream` that has not rendered yet. Needs confirming against a real thread
before there's anything to fix. Ideally show a real loading message instead.

**Next harness upgrades** — the original three (edit + diagnostics, thread
compaction, tests over the crown jewels) are done as of 2026-07-27. What the
assessment named and nobody has touched: (1) loop control — a plan/approve
checkpoint and budget-aware pacing, since `MAX_STEPS=1000` leaves the watchdog
as the only real governor; (2) orchestration depth — more than one subagent
level, parallelism not opt-in per call; (3) provider-native paths, because the
openai-compatible abstraction is now carrying four separate workarounds.

**The duplicate confirm-post acceptance message is only half explained.** The
DM-fallback path definitely misbehaved — `replace_original` does nothing on an
ordinary DM message, so the outcome landed BESIDE a prompt whose buttons stayed
live — and that is fixed. But a true ephemeral is replaced correctly, so if the
duplicate is still seen, grab the actual thread/DM and the timestamps: the
remaining possibility is the confirm going to BOTH the thread and the DM, which
the current code shouldn't do.

### Watch list

**HCAI's own FAQ says coding agents are banned.** From the HC AI support thread
the owner pasted 2026-07-28: "we recommend DeepSeek V4 for most tasks … and GLM
5.2 for advanced coding (remember all coding agents are banned in HCAI)". kyto is
an agent that writes and runs code, and HackClub is its PRIMARY tier plus the
whole shared fallback chain. Nobody flagged it at the time. Not a bug — a
standing account risk worth knowing about, since losing that account takes the
primary and every cheap rung with it.

**The netic (`netic.hackclub.app`) key is DEAD as supplied (checked 2026-07-29).**
`GET /v1/models` answers 200 over https and lists all seven slugs
(`big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `ling-3.0-flash-free`,
`nemotron-3-ultra-free`, `north-mini-code-free`, `laguna-s-2.1-free`), but every
`POST /v1/chat/completions` returns `401 {"error":{"message":"Invalid API key"}}`
— tested on all seven, and directly against https so it is not a redirect
stripping the header. Note it is http:// in the message and 308-redirects to
https. Nothing was wired up: the rule is no tier without a live account behind
it. Ask your friend for a working key and it can be added as a free tier in
front of Gemini.

**9Router + Kiro: do not use (researched 2026-07-29).** Kiro's own FAQ says
"Use with OpenClaw and similar tools that leverage third-party harnesses is
prohibited", which is exactly what an OpenAI-compatible bridge is, and its terms
separately prohibit rate-limit evasion — which is what round-robining AWS
Builder IDs is FOR. AWS actively detects and blocks multi-account signups. Also
Kiro is not even a built-in 9Router provider yet (open feature request), so it
would need a third-party wrapper on top. Not worth kyto's uptime or the account.

**Free tiers worth trying instead, ranked (researched 2026-07-29).**
1. **NVIDIA NIM** — `https://integrate.api.nvidia.com/v1`, permanently free key,
   no card, ~40 RPM, tool calling confirmed on GLM-5 / DeepSeek V4 / Qwen3 /
   Kimi K2.6. Best structural fit; no expiring credits.
2. **Cloudflare Workers AI** — built for low TTFB, which is the property that
   matters against HackClub's 5s header timeout. 10k Neurons/day.
3. **Groq** — LPU hardware, famously fast first token. Watch the ~6k TPM
   ceiling against kyto's system prompt + tool schemas.
Not worth it: Cerebras (~5 RPM ceiling is incompatible with a tool loop),
GitHub Models (8k input cap), DashScope (90-day expiring trial, and duplicates
the qwen3.7-plus primary), DeepSeek direct (one-time grant), xAI data-sharing
(pays in user conversation content). OpenRouter's free tier lost a third of its
catalogue in nine days — don't hard-code a `:free` slug as a permanent rung.

**Deferred-tool data is now being collected.** Every turn logs
`[tools] turn summary` with `loaded` / `loadedUsed` / `loadedUnused` /
`coreUsed`. After a few days: promote anything always-loaded-and-used into
`core`, defer any core tool that never shows up in `coreUsed`, and look at
`loadedUnused` — that is a round trip and a schema paid for nothing.

**The prompt is now ordered for caching; watch that it holds.** The volatile
`<your_previous_thinking>` block moved BELOW the thread history so system +
instructions + compacted + history is a stable append-only prefix. If anyone
adds a new block, it goes below `history` or the cache breaks again silently —
the only symptom is the bill.
Caching IS now measurable (2026-07-30): `turn complete` logs
`cache: { input, read, write }` from the answering attempt. Nothing logged it
before, so a broken cache would only have shown up on the bill. Read high +
input low across a thread's turns = the breakpoints are landing.

**The ChatGPT account is parked until 2026-08-23.** The linked account is on a
FREE plan and its quota is spent; the 429 named that reset date, which is now
stored in `user_chatgpt_accounts.quota_resets_at` and the attempt is skipped
until then. If ChatGPT turns are wanted before that, the account needs a paid
plan. A completed turn clears the park automatically.

**HackClub sometimes serves opus-4.5 for a slug kyto never asks for** — a turn
came back `(Empty response: {'content': [], 'model': 'claude-opus-4-5…'})`.
Kyto already filters the placeholder and falls back; whether HackClub remaps
slugs upstream is their question. Watch whether it recurs.

**The DigitalOcean tier is gone (2026-07-27)** — the account behind it stopped
being provided, so the whole `openrouter-do` tier, its key, and both of its
write-offs were deleted from kyto, and the same dead key was removed from
`stardance-archive` (its `gemini` embedder now calls Google directly; same model,
same 3072 dims). Fallback is HackClub then the owner's Gemini key, with nothing
free in between — so watch how often `BudgetExhaustedError` actually shows up
now that HackClub's daily $3 is the only shared tier.

**HackClub's proxy 504s (reported to the HC AI team 2026-07-27).** Bursty, ~5.4s
every time, size- and shape-independent, reproducible with bare `curl` — theirs,
not ours. Three things now sit between it and a user: `gateway-retry.ts` replays
a gateway status twice; a 504 no longer condemns the whole HackClub tier
(`condemnsHackclub`); and the tier it falls back to is kimi-k2.6 then
minimax-m3, both cheaper than the primary. Watch `[agent] gateway failure,
retrying the same request` in the journal — retries EXHAUSTING means the burst is
worse than measured. Also watch what the cheap rungs actually produce in public:
they are now the only thing between the primary and Gemini, and nobody has read a
k2.6 or m3 answer in a live thread yet.

**Compaction is new and unproven in the wild (2026-07-27).** No thread has
crossed 100 messages since it shipped. Check the first one that does: the
`<earlier_in_this_thread>` block should carry real decisions, and the summarizer
runs on the Gemini subagent key — if that key is ever unset the block degrades to
a bare count, which is intended but worth seeing once.
100+msg or a certain token count

### New bugs (from the 2026-07-29 paste — distilled from raw transcripts)

**Status narration lands in the Thinking card instead of reasoning.** A turn's
Thinking card showed "9089 out of 9999 codes done already! Let me run the
server-side exploits test…" and "50 more steps running" — i.e. plan/status text,
not the model's actual reasoning, and the real reasoning wasn't shown. Owner:
"it does not show its reasoning but this."

Audited 2026-07-30 and NOT reproduced from the code: kyto never classifies
anything as reasoning. It arrives pre-separated in the provider's own
`reasoning_content` channel, and the inline `<think>` splitter only moves text
the model itself tagged. Two candidates left, both needing a real thread:
(a) the model genuinely wrote that as its reasoning, which is a prompt/model
issue, not a routing one; (b) the card was TRUNCATED to its last fragment — that
one is plausibly already fixed, since an unclosed reasoning block used to leave
the card with no output at all (see the `reasoning-tracker` fix, same date).
Next time it happens, grab the raw `fullStream` parts, not the rendered card.

