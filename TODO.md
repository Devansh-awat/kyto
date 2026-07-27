# Kyto TODO

## When something is done, remove it from here
## how this works: i put my ideas, problems, etc here, then every 2 or so days i ask claude(you) to fix it. 

### Open

**Going public is now only blocked on two small licence checks.** The
gorkie-provenance question is MEASURED (2026-07-26, blame-based, in
`docs/reference/publishing.md`): ~16% of runtime source lines are still
gorkie-derived, so the MIT carve-out stays — that decision is made. Skills
provenance is documented (8 pinned in `skills-lock.json`, 2 first-party); two
skills need their upstream licence confirmed or dropping before the flip
(`ai-sdk` — GitHub reports "Other"; `thermo-nuclear-code-quality-review` —
`cursor/plugins` has no detectable licence). Then rotate `GH_TOKEN` and re-run
the secrets scan.

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

### Watch list

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

**Compaction is new and unproven in the wild (2026-07-27).** No thread has
crossed 100 messages since it shipped. Check the first one that does: the
`<earlier_in_this_thread>` block should carry real decisions, and the summarizer
runs on the Gemini subagent key — if that key is ever unset the block degrades to
a bare count, which is intended but worth seeing once.
