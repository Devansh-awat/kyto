# Kyto TODO

## When something is done, remove it from here

### Open

**Decide the gorkie-provenance question before making the repo public.** The
licence is written (`LICENSE`, source-available/all-rights-reserved, per owner:
readable but nobody may copy or use it) and the secrets audit is clean — see
`docs/reference/publishing.md`. What is NOT settled: kyto forked MIT-licensed
gorkie and still carries its whole history, so gorkie-derived code stays MIT
(`LICENSE-gorkie-MIT`) and that carve-out can't be waved away. The harness is a
ground-up rewrite so the surviving fraction may be ~zero, but nobody has measured
it. Also: `.agents/skills/` vendors third-party skills with undocumented
provenance — document or drop them.

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

**HackClub served opus-4.5 for a request.** A turn came back as
`(Empty response: {'content': [], 'model': 'claude-opus-4-5-20251101'})`. Kyto
never asks for 4.5 — it isn't in `LEADERBOARD_FALLBACK` — so the proxy resolved
one of our slugs to it upstream. The placeholder text is already filtered and
the empty response already falls back, so this is a "what is HackClub doing"
question, not a kyto bug.

### Watch list

**The ChatGPT account is parked until 2026-08-23.** The linked account is on a
FREE plan and its quota is spent; the 429 named that reset date, which is now
stored in `user_chatgpt_accounts.quota_resets_at` and the attempt is skipped
until then. If ChatGPT turns are wanted before that, the account needs a paid
plan. A completed turn clears the park automatically.
