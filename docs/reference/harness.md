# Harness assessment — kyto vs the coding agents

> Written 2026-07-26 (Claude, at the owner's request), comparing kyto's agent
> harness with OpenCode (MIT), OpenAI Codex CLI (Apache-2.0), and Claude Code
> (proprietary). Graded on harness machinery only — loop mechanics, streaming,
> tools, context, recovery — not the trust/security model. Snapshot of a moving
> target: the three comparators ship weekly; re-check before citing specifics.

## Where kyto's harness is ahead

- **Failure resilience — best-in-class.** No other agent does cross-model
  mid-task handoff. Kyto detects mid-stream provider death (error part +
  non-`stop` finish), stalls (re-armed idle watchdog), token loops (repetition
  guard trips before anything reaches Slack), and truncated tool-call JSON
  (repaired, not fatal), then hands the SAME task to the next model with
  continuation context + tool-result carryover. Claude Code waits out an
  Anthropic outage; Codex retries and gives up. Born of unreliable free tiers,
  but the engineering transfers.
- **Streaming UX for a chat surface.** Segmented plan blocks (narrate between
  tool stretches), unique per-step reasoning ids, proactive stream-card
  rotation before Slack's ~5-min expiry, hallucinated-tool hiding, markdown
  healing across chunk cuts and table splits. Problems the TUIs never meet.
- **Context economy.** `loadTools`/`activeTools` keeps ~40 deferred tool
  schemas out of every prompt (Claude Code's ToolSearch is the analogue;
  OpenCode/Codex mostly ship full toolsets every request).
- **Code Mode.** One sandboxed TypeScript program instead of N model
  round-trips. None of the three have a direct equivalent (Claude Code's
  Workflow is the nearest cousin).
- **Persistent per-thread sandbox.** Lazy create, pause/resume, scheduled jobs
  reattaching to the same filesystem days later. Codex cloud tasks are
  comparable but don't persist per-conversation.

## Where kyto's harness is behind

- **Precision editing (biggest gap).** `writeFile`/`editFile` are coarse.
  Claude Code's Edit demands an exact unique match and fails loudly; Codex has
  the `apply_patch` diff contract; OpenCode feeds LSP diagnostics back into
  the loop so the model SEES the type error it introduced. Kyto's model only
  learns a change broke something if it thinks to run something.
- **No compaction.** Context = re-read thread (capped) + 3-turn thinking
  cache. Outgrow the cap and the oldest context silently drops. Claude Code
  and Codex summarize/compact; kyto has nothing between "fits" and
  "truncated".
- **Blunt loop control.** `MAX_STEPS=1000` means the real governor is the
  watchdog + degenerate guard. No plan/approve checkpoint, no budget-aware
  pacing, no steering a runaway-but-productive loop short of interrupting.
- **Shallow orchestration.** One subagent level, sequential by default. The
  ChunkRelay visualization is lovely; the orchestration behind it is thin
  next to Claude Code's Task/Workflow layer.
- **The openai-compatible abstraction taxes everything.** Riding the `ai`
  SDK's lowest-common-denominator path costs provider-native features and
  breeds the hack collection (thought_signature tee, `top_p` pinning,
  `store:false` double-force, cache-control body rewriting). Each is correct;
  together they mean the abstraction is fighting us.
- **Test coverage.** Four test files over a harness this behavior-rich:
  segmentation, fallback ordering, and carryover invariants are guarded by
  docs and vigilance, not CI.

## Net

As a CONVERSATION-surface harness (streaming, rendering, multi-model
survival, tool economy) kyto is better than anything comparable. As a
WORK-execution harness (editing precision, compaction, loop steering,
orchestration, verification) it is a tier below all three coding agents.

## Highest-leverage upgrades, in order

1. **Exact-match edit tool + automatic diagnostics feedback** — an edit tool
   that fails loudly on ambiguity, and a cheap post-edit pass (tsc/linter in
   the sandbox) whose errors are fed back to the model automatically.
2. **Thread compaction** — summarize overflow context instead of dropping it
   when a thread outgrows the fetch cap.
3. **Tests over the crown jewels** — the fallback walk, stream segmentation,
   and carryover, so regressions there are caught by CI instead of users.
