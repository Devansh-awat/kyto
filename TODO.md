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

**Harness upgrades** (from the 2026-07-26 harness assessment,
`docs/reference/harness.md`), in leverage order: (1) exact-match edit tool +
automatic post-edit diagnostics (tsc/lint fed back to the model), (2) thread
compaction instead of silent truncation past the fetch cap, (3) tests over the
fallback walk / stream segmentation / carryover.

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

**Fallback storms (2026-07-26)**: the ~10-deep "Thinking · fallback" walks were
DigitalOcean's content filter 403ing the same prompt on every DO rung (321
times in 5 days). One filtered attempt now writes off the DO tier for the turn
(`digitaloceanContentFiltered`). Watch that storms are actually gone; the
companion browser failure was a stale E2B template, rebuilt the same day.
