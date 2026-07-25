# Kyto TODO

## When something is done, remove it from here

### Open

**Pick an open-source licence.** People asked how safe their creds are with
kyto; one answer is going open source. Needs a decision on which licence, and a
pass over the repo for anything that can't be published (prompts are fine,
`.env` obviously isn't). See `docs/reference/security.md` for what the honest
answer to the creds question is today.

**No self-serve "forget me".** Hack Club confirmed temporary storage is fine,
but if someone withdraws consent the only route today is the owner deleting
their memories on the dashboard and waiting out the ~30-day `thread_thinking`
window. A user-facing command would be better.

**"Thinking..." shows as plain text before the plan block appears**, and when
the block does appear it already has thinking in it. Investigated: no such
string exists anywhere in kyto, and the first plan chunk is already pulled
before the stream opens, so this looks like Slack's own placeholder for an open
`chatStream` that has not rendered yet. Needs confirming against a real thread
before there's anything to fix.

**Thinking cards render as a single line.** Worth confirming this is genuinely
one line of reasoning (gpt-5.6 returns short `reasoningSummary` text, so it
probably is) rather than longer thinking being truncated somewhere.

**HackClub served opus-4.5 for a request.** A turn came back as
`(Empty response: {'content': [], 'model': 'claude-opus-4-5-20251101'})`. Kyto
never asks for 4.5 — it isn't in `LEADERBOARD_FALLBACK` — so the proxy resolved
one of our slugs to it upstream. The placeholder text is already filtered and
the empty response already falls back, so this is a "what is HackClub doing"
question, not a kyto bug.
