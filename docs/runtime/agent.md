---
title: Agent Runtime
description: How a turn runs, and how it survives a model dying halfway.
---

The agent loop is this repo's own code: `apps/bot/src/lib/agent/index.ts` around
`streamAttempt` in `packages/ai/src/agent.ts`, which is a thin wrapper over AI
SDK `streamText`. One turn is a multi-step tool loop with a very high step
ceiling — the real bounds are the watchdog, the degenerate-output guard, and the
model's own `skip`, because a hard step cap used to strand long jobs mid-solve.

## An Attempt

Each attempt is one model on one provider, with its own `@ai-sdk/openai-compatible`
provider instance and a per-request `fetch` that tunes the body for that
provider. An attempt is **handled** if and only if it produced reply text or a
deliberate `skip`. A model that ran tools but wrote nothing gets one nudge to
finish — with its tools still on, so it can — before the turn moves on.

## Fallback

`buildFallbackQueue` walks by tier, best-first within each tier. It must not
pivot on the primary's rank: an earlier version walked "up from the pivot",
which reversed the leaderboard and fell back worst-first.

A turn that has **already streamed text** can still fall back, for exactly three
reasons:

- a degenerate loop (`degenerate.ts` — repeated lines caught before Slack sees
  them);
- a stall (the per-attempt idle watchdog, re-armed on every text delta, tool
  call and tool result, so a slow-but-working turn is never killed);
- `StreamInterruptedError` — a provider dying mid-stream does not throw, the SDK
  turns it into an `error` part and ends the stream, which once left turns
  silently unfinished while looking handled.

The next model is handed a continuation notice plus carryover: what was said,
and what tools already ran, so it does not repeat a side effect.

A gateway-status failure (408/502/503/504/520/522/524) is replayed inside the
same attempt before it is allowed to cost a fallback — the model never ran, so a
replay is safe. Everything else routes away on the first try.

## Escalation

The model can call `upgradeModel` to move itself to a stronger rung. The call
ends the attempt like `skip` and the turn continues with the work so far as
carryover. It is capped per turn and per day, because those rungs cost tens of
times the primary against a shared budget — and an upgrade **sticks to its
thread** for a short idle window, since escalation that lasted one turn sent the
next message straight back to the model that had just said it could not do it.

## Context For A Turn

`buildPrompt` assembles, in cache-friendly order:

- the system prompt and tool schemas (stable — nothing volatile may enter them);
- a compacted digest of the part of the thread that no longer fits;
- the thread replayed verbatim, oldest first;
- what kyto was thinking on its last few turns;
- the volatile tail: the clock and the current message.

Order matters because the whole thing is cached as a prefix: one changed byte
near the front throws away everything after it. `cache-probe.ts` logs any step
whose prompt is not a pure append of the previous one.

## What Is Tested

The IO is not easily testable; the decisions are. The pure halves live in their
own modules with tests — `routing.ts` (fallback order), `segmentation.ts` (block
splitting), `carryover.ts` (what a fallback model is told), `compaction-plan.ts`,
`thinking-render.ts`, `degenerate.ts`. These are the rules that broke in ways
users saw. `index.ts` calls into them; none of them should be inlined back.
