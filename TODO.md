# Kyto TODO

## When something is done, remove it from here

- **Test the AgentMail key** — key was added; exercise `sendEmail`/`checkInbox`/`replyEmail` end to end to confirm it works.

- **"Shows something went wrong when it didn't, and the agent continues."** Needs a concrete example (permalink/screenshot) to fix the exact surface. Investigated 2026-07-17: the mid-stream provider `error` part does NOT render a plan card (only logs + falls back), and the terminal "_oops, something went wrong._" only posts after the whole fallback chain is exhausted. The most likely culprit is a recoverable TOOL error card (red) that's actually fine, or an `after_text` error when a 504 hit mid-stream and the continuation gave up. Point at a specific message before changing error rendering.

- **Agent stops in the middle.** Partly mitigated: a provider dying mid-stream now raises `StreamInterruptedError` and the next model continues (`renderContinuation`). Remaining cause is provider latency/504s (see slowness). If it still happens on a specific turn, grab the thread id + timestamp so the journal (`[agent] attempt failed, falling back` / `turn failed`) can pin it.

- **Slowness — mostly the model/provider, not our bug** (measured 2026-07-17): single-step turns on the pinned primary (`moonshotai/kimi-k2.6` on HackClub) run ~9–32s of raw model latency; multi-step turns are N× that (a 9-step turn took ~125s). Only ~5% of turns hit a 504 gateway timeout. Levers that are ours: fewer steps via `codeMode`/parallel tool batching (already prompted), a faster primary (owner's routing call in `.claude/MODELS.md`), or dropping `maxRetries` for the primary so a 504 fails over faster instead of retrying twice.
