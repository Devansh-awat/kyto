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

## The visible-card budget is PER PLAN MESSAGE

`lib/ai/stream/cards.ts` (tested). **There is NO cap** (owner's call, 2026-08-09:
"i want ZERO budget") — every tool call and every thinking block gets its own row.
The machinery is kept because a caller can still pass a limit, and because the
per-message reset is what fixes the bug below; the DEFAULT is unlimited.

- The budget is counted **per plan message**, and the CALLER owns it because
  renderStream cannot see where a message ends — `streamSegmented` cuts one on
  every split, `harness.stream` cuts one every `STREAM_ROTATE_MS`. It used to
  live inside `renderStream` for the whole attempt with a cap of 45, so a long
  turn spent every slot in its FIRST message and each one after that could only
  render the overflow row: a Thinking card, no tool cards, and a bare "38 more
  tool calls". Reported for a MONTH. Both halves are fixed — the reset, and then
  the cap itself.
- `endMessage()` is called at both boundaries. It resets the counters **and**
  returns a `complete` for every card still mid-flight — a card id only exists
  inside the `chatStream` it was appended to, so one left `in_progress` can never
  be updated again and a collapsed plan renders it as broken.
- Two overflow rows, never one: a shared counter mixed hidden tool calls with
  hidden thinking blocks, which read as kyto narrating step counts.

## Tool-call markup never reaches the reply

`lib/ai/stream/tool-markup.ts` (tested). When a provider fails to parse a model's
tool calls, the model writes its NATIVE markup into the text channel instead —
a real turn ended with screens of `<｜DSML｜invoke name="postMessage">` repeated
six times, because the harness never answered a call it never saw. The tell is
**U+FF5C right after `<`**, which no reply should ever contain; from there on the
attempt's text is dropped (not trimmed tag by tag — the arguments are the bulk of
it) and a warning names the cause, since those calls never executed.

## "no tools loaded" never reaches the reply

`lib/ai/stream/tool-complaints.ts` (tested). kyto has three PROSE-ONLY recovery
calls — finish the sentence you were cut off mid-way through
(`continueTruncatedReply`), write the report you skipped (an agent reminder's
nudge, a subagent's). Those used to be made with `tools: {}`, which contradicted
the system prompt sitting right above them (it describes fifty tools and says to
call `loadTools`), and weak models resolved the contradiction by narrating it:
"no tools loaded", or the observed "getFile isn't available… loadTools isn't
available either… No tools available? That's strange".

**The contradiction itself is now gone (owner's call 2026-08-22, "NEVER LAUNCH
MODELS WITHOUT tools"): every one of those calls carries the REAL toolset**, and
its prompt asks for prose without ever naming tools — naming the thing you forbid
is how it kept ending up in the output. The one deliberate exception is
compaction (`SUMMARY_SYSTEM`), whose standalone summarizer prompt never mentions a
toolset, so there is nothing to narrate; handing IT tools would invite a
background digest job to start calling them.

**And on top of that, a DROP, because three rounds of prompt fixes kept
regressing** (a notice saying tools are off deliberately; keeping tools ON for
`synthesizeFinalAnswer` — commit `ea22baf`; prose-only wording). Wording cannot
guarantee a weak model's output, and each fix only covered the call site that
happened to be hot that week — `continueTruncatedReply` was near-dormant until a
cut-off Zen stream started routing into it, at which point the same sentence
reappeared from a path nobody had touched.

- **Scope is what makes it safe**: it runs ONLY where the CALLER declares the call
  prose-only (`dropToolComplaints` on `renderStream`, or `stripToolComplaints`
  over collected text). There such a sentence cannot be a legitimate answer — and
  now that tools are always registered, it is also simply false. A normal turn
  filters nothing, so "which tools do you have?" still gets an honest answer.
- Sentence-level, and a complaint must be **short** (≤200 chars) — a real
  paragraph that happens to pair "tool" with absence language is left alone. The
  filter holds the tail after the last sentence boundary so a complaint is never
  half-posted and then retracted, and a reply with no complaint passes through
  byte-for-byte.
- Two shapes are matched: the word tool/tools/toolset alongside absence language,
  and a **camelCase identifier** plus absence (`getFile isn't available`) — the
  latter never says "tool", which is exactly how the observed spiral slipped past
  a tool-word-only check. Curly apostrophes count.
- **The identifier rule is CASE-SENSITIVE, and must stay that way.** An `i` flag
  makes `[a-z]` match capitals too, which degrades "a camelCase identifier" into
  "any capital-letter word near the word available" — the first draft shipped that
  way and, checked against real persisted reasoning, it ate `slack:
  'admin.emoji.remove' is not available`, `Search token expired or not
  available`, `Chat Not available in this workspace`, and `If Porkbun says not
  available and the registry says taken`. Deleting a real answer is a far worse
  bug than leaving a complaint in, so those four are pinned as tests. The
  identifier→absence gap is capped at 24 chars for the same reason: the absence
  has to be ABOUT the identifier, not merely in the same sentence.
- It **logs** what it dropped. If that line is frequent, whatever made the model
  say it is what to fix — the drop must not become the new invisible bug.
- `stripToolComplaints` applies the same rule to collected (non-streamed) text:
  the reminder and subagent report nudges, and compaction's digest.
- The prose-only wording stays as belt (`PROSE_ONLY_NOTICE`, `REPORT_NUDGE`). The
  old wording ANNOUNCED an empty toolset ("every tool has been switched off
  deliberately… if something is genuinely missing, say so in one short sentence")
  — naming the thing it forbade, then inviting exactly the complaint.

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
