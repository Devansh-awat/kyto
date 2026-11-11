---
paths:
  - "apps/bot/src/lib/agent/**"
  - "apps/bot/src/harness/**"
  - "apps/bot/src/lib/ai/stream/**"
---

# Agent-loop modules, plan UI, message layout, reply footer

Part of the project notes (`.claude/CLAUDE.md`); loaded when you work on these files. Keep it current in the same change as the feature.

- **The pure halves of the agent loop live in tested modules** (`routing.ts`, `attempt-router.ts` — the per-turn model walk —, `segmentation.ts`, `carryover.ts`, `compaction-plan.ts`, `thinking-render.ts`, `reasoning-tracker.ts`, `fallback-cache.ts`), with the recovery passes in `recovery.ts` and the footer in `reply-footer.ts` — do NOT inline one back.
- **NOTHING in the plan is hidden** — any budget is per MESSAGE, owned by the caller (`endMessage()` at each boundary).
- **Tool-call markup** (`<｜DSML｜…`) and **"no tools loaded" sentences** are never a reply (`tool-markup.ts`, `tool-complaints.ts`). Recovery calls keep their REAL toolset; the sentence filter applies only where a call is declared prose-only. Do not replace it with another prompt tweak.
- **Message layout** (owner's call 2026-10-13, `streamSegmented`): reply text streams INTO a message and the cards after it join that message; visible text after cards opens the next one; the footer rides on the last. Cut otherwise only at ~10k chars (code fences closed and reopened). Fences, em dashes, nested tables and MCP cards: `STREAMING.md`.
- **Reply footer**: time taken, Slack's native small 👍/👎 (`context_actions` + `feedback_buttons`, value `up:`/`down:<model>`; a click saves the rating, then an optional comment modal; `reply_feedback`, owner DM'd), and a note naming the weaker model when the primary wasn't used. Rendering detail in `STREAMING.md`.
- **`outputOnly` tool** (#218): the model calls it FIRST when asked for "nothing else"/"only X"; the turn then drops every card and thinking row, the "done in Xs" line, the feedback buttons and the instructions note, keeping only the reply (and a weaker-model note). A message left with no reply text is deleted.
- **"Something went wrong" is the model provider's alone** (owner's call, #20): `stream({ showFailure })` keeps a stopped message's open cards as failed only for a model provider error (`isProviderFailure`: an HTTP status in the chain, not kyto's own `BudgetExhaustedError`, which gets its budget line instead); a stop, restart or kyto bug closes them as done. The main turn and the subagent stream both pass it. A message is also rotated BEFORE its cards fill it (`currentCardChars`), not after Slack refuses.
- **A turn with no output at all** (no reply text, no tool call: skipped, stopped, interrupted) deletes its plan messages (#34). **`filterOutbound` strips `<your_previous_thinking>`** from everything sent to Slack, and the stream filter drops an echo of it like tool markup (#223).
