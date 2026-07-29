# Kyto TODO

## When something is done, remove it from here
## how this works: i put my ideas, problems, etc here, then every 2 or so days i ask claude(you) to fix it. 

### Open

**Going public is now only blocked on ONE licence check.** The gorkie-provenance
question is MEASURED (2026-07-26, blame-based, in `docs/reference/publishing.md`):
~16% of runtime source lines are still gorkie-derived, so the MIT carve-out
stays — that decision is made. Skills provenance: `ai-sdk` is RESOLVED
(2026-07-29) — it comes from `vercel/ai`, which is **Apache-2.0**; GitHub
reporting "Other" was wrong. Redistributable with the notice "This software
contains components from Vercel's AI SDK, licensed under Apache License 2.0.
Copyright 2023 Vercel, Inc." Still open: `thermo-nuclear-code-quality-review`
(`cursor/plugins`) — its README says "MIT" but the repo has **no LICENSE file**
and GitHub detects none, so the claim is unverifiable. Either ask the
maintainers for a LICENSE file or drop the skill before the flip. Then rotate
`GH_TOKEN` and re-run the secrets scan.

**"Thinking..." shows as plain text before the plan block appears**, and when
the block does appear it already has thinking in it. Investigated: no such
string exists anywhere in kyto, and the first plan chunk is already pulled
before the stream opens, so this looks like Slack's own placeholder for an open
`chatStream` that has not rendered yet. Needs confirming against a real thread
before there's anything to fix. Ideally show a real loading message instead.

**Thinking cards render as a single line.** Worth confirming this is genuinely
one line of reasoning (gpt-5.6 returns short `reasoningSummary` text, so it
probably is) rather than longer thinking being truncated somewhere. Try again
and look at the raw response.

**Next harness upgrades** — the original three (edit + diagnostics, thread
compaction, tests over the crown jewels) are done as of 2026-07-27. What the
assessment named and nobody has touched: (1) loop control — a plan/approve
checkpoint and budget-aware pacing, since `MAX_STEPS=1000` leaves the watchdog
as the only real governor; (2) orchestration depth — more than one subagent
level, parallelism not opt-in per call; (3) provider-native paths, because the
openai-compatible abstraction is now carrying four separate workarounds.

**`.claude/CLAUDE.md` is ~47k chars, over its own stated 40k budget.** It says
to keep it to the durable what-and-why and delete post-mortem narrative. Needs a
pass; nothing in it is wrong, there is just too much of it.

**The duplicate confirm-post acceptance message is only half explained.** The
DM-fallback path definitely misbehaved — `replace_original` does nothing on an
ordinary DM message, so the outcome landed BESIDE a prompt whose buttons stayed
live — and that is fixed. But a true ephemeral is replaced correctly, so if the
duplicate is still seen, grab the actual thread/DM and the timestamps: the
remaining possibility is the confirm going to BOTH the thread and the DM, which
the current code shouldn't do.

### Watch list

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
