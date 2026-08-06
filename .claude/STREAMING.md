# Streaming, the plan UI, and how a turn renders

Not loaded automatically (same convention as MODELS.md / TOOLS.md / OPS.md).
**Read it before touching `lib/agent/index.ts`'s streaming half, `lib/ai/stream/`,
`lib/agent/reply.ts`, or `harness.stream`.** Every rule here is one that broke in
a way users saw.

## Multi-block turns — `streamSegmented`

`agent/index.ts`. A turn is a SEQUENCE of plan messages, not one. A new block is
cut whenever a task card arrives AFTER reply text has streamed
(`[plan] text [plan] text`), so the model can post an update and keep working.
`renderStream`'s `emitText: true` yields reply text inline with task chunks in
stream order; `createReply` posts it (length-splitting, fence/table healing).

- **Only VISIBLE text splits a block** (`isVisibleText`): whitespace-only
  fragments between tool calls don't count, else every stretch of tools would
  open an empty collapsible block.
- The attempt's **Thinking card completes at first visible reply text**, so it
  finishes inside its own block instead of a later one where its id doesn't
  exist (else a perpetually spinning Thinking).
- **The Thinking card's title names WHY this attempt is running**: plain
  `Thinking` for the first, `Thinking · upgraded` when `upgradeModel` routed the
  turn onto a stronger rung, `Thinking · fallback` for an actual failure. They
  are not the same event and must not read the same — an escalation the model
  asked for is not kyto recovering from a broken provider.

## Reasoning rows

`Reasoning` renders under `Thinking`, one row per BLOCK, and **every block that
opens must close** (`stream/reasoning-tracker.ts`, tested).

- Providers label every block `reasoning-0`, so keying the card on `part.id`
  collapsed a whole turn's thinking into one pinned row; the tracker mints its
  own id per block instead.
- Providers emit `reasoning-end` only from the stream's flush, so a stream that
  dies or is aborted mid-thought (proxy 504, stall watchdog, degenerate guard,
  user stop) sends none. The card then stuck on `in_progress`, which is what made
  a **collapsed plan render that row as "something went wrong"**, and the
  thinking never reached `onReasoning` for the next turn. `renderStream` closes
  what is open on the normal end AND in a `catch` before rethrowing, and
  reopening a live id closes the orphan first.

## Card rotation

**Long turns rotate the stream card** (`harness.stream`, `STREAM_ROTATE_MS` =
4.5 min): Slack drops appends after ~5 min on a single `chatStream`, so
`stream()` stops it and opens a fresh plan message before the limit. The
rotation lands naturally on chunk arrival.

## Skips

- **A `skip` ENDS the attempt** (`SKIP_TOOL_NAME` + `hasToolCall` in
  `streamAttempt`'s `stopWhen`): its tool result used to feed back into the loop,
  so a model that declined to answer was asked again about the same message — 5+
  Thinking→skip→Thinking cycles, budget spent on a message already ignored. The
  stop lives in `streamAttempt`, not per call site, so a new caller can't re-open
  it; the toolset registers the tool under that constant.
- **A bare `skip` written as TEXT is treated as a skip** (`isBareSkipText`): a
  model meaning to stay quiet should call the `skip` tool but some write the
  word. Only a reply that is NOTHING but the token counts (so "skip the first
  step" still posts), retracted via `reply.dropTail` — not `drop()`, which would
  discard a previous attempt's real answer too.

## Odds and ends

- **Hallucinated tool calls are hidden.** Weak models sometimes call an
  unregistered tool; `renderStream`'s `knownTools` drops any such call (and its
  result/error) instead of surfacing "Tool X not found".
- **Usage footer** (`postUsageFooter`): a muted context block,
  `<output tokens> · <N> tok/s`. Per-user opt-out via
  `user_customizations.show_usage_footer` (App Home). The resolved model shows in
  `Thinking`, not here.
- **Channel names are linked on the way out** (`lib/slack/channel-links.ts`): the
  model writes `#some-channel` because that is how a channel reads everywhere
  else, and Slack renders that as plain text. Resolved off a cached name→id
  index; an unknown name is left exactly as written. Channels only — a person or
  a user group is never auto-resolved, because guessing which `@name` is whom is
  how you ping the wrong person or a whole group nobody asked for.
