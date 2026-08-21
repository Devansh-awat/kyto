# Kyto TODO

## When something is done, remove it from here
## how this works: i put my ideas, problems, etc here, then every 2 or so days i ask claude(you) to fix it. I also leave notes between the stuff you put here.

### Open

**DECIDE: retire the 139 sandboxes created before the GitHub proxy.** The proxy
shipped 2026-08-06 and nothing NEW gets the PAT brokered into it — but E2B egress
rules are fixed at CREATE time, so every sandbox that already exists still has the
old rule injecting the real token on every github.com request, until it is
recreated or the reaper kills it (30 days of inactivity, and a warm one never
ages out). Not a new exposure — it is the old one persisting — but it is the last
piece of the hole. Killing them costs 139 threads their sandbox filesystem:

```sh
cd apps/bot && bun -e "import {Sandbox} from '@e2b/code-interpreter'; \
  const {db}=await import('@repo/db'); const {sql}=await import('drizzle-orm'); \
  const rows=await db.execute(sql\`select sandbox_id from thread_sandboxes\`); \
  for (const r of rows) { await Sandbox.kill(r.sandbox_id,{apiKey:process.env.E2B_API_KEY}).catch(()=>{}); } \
  await db.execute(sql\`delete from thread_sandboxes\`); process.exit(0)"
```

Say the word and it runs; otherwise it closes itself out over the next month.

**The TokenRouter key has $0.00 credit — unusable as supplied (checked
2026-08-06).** `GET /v1/models` lists ~40 slugs (deepseek-v4-pro, qwen3.7-max,
gpt-5.2, claude-opus-4.8-fast, kimi-k3-free, …) but every paid one answers
`insufficient_user_quota — remaining credit limit: $0.00`, and the one free slug
(`moonshotai/kimi-k3-free`) hung for 45s with zero bytes, twice. Nothing was
wired up: same rule as netic, no tier without a live account behind it. If it is
supposed to have free credit, the account needs topping up or a different key.

**Is deepseek-v4-pro better than the v4-flash primary?** Asked 2026-08-06, not
answerable yet: pro is reachable on mebbo, but a fair comparison needs the same
prompts through both and a look at first-byte latency, which is what actually
loses turns against HackClub's 5s header timeout. Worth doing as its own pass —
flash was picked partly BECAUSE it answers fast, so "pro is smarter" alone does
not settle it.

**Two things the Slack OAuth grant still unlocks.** Searching as the user
shipped 2026-08-09 (see below); these two have not:
- **send as the person who asked**, with THEIR confirm click. The machinery
  exists — the confirm-post gate already routes a mirrored post to the person
  being mirrored (`approverUserId`). This would make that real rather than an
  impersonation of them by the owner's token.
- **reading a private channel or DM needs their approval per use** — the grant
  is consent to the capability, not to any particular read. Wire it through the
  same confirm gate.

**Reduce the system prompt.** Asked 2026-07-28 and still not attempted. Measure
the assembled prompt first; it is paid on every turn of every thread against the
shared $3/day. Note this got LESS urgent on 2026-08-05: the system prompt is now
stable across a thread's turns, so it should be a cached read rather than a
full-price one — measure the cache first, then decide if trimming is still worth
it.

**"Thinking..." shows as plain text before the plan block appears.** No such
string exists anywhere in kyto and the first plan chunk is pulled before the
stream opens, so this looks like Slack's own placeholder for an open
`chatStream` that hasn't rendered yet. Needs confirming against a real thread.

**Next harness upgrades** — the assessment's remaining three: (1) loop control —
a plan/approve checkpoint and budget-aware pacing, since `MAX_STEPS=1000` leaves
the watchdog as the only real governor; (2) orchestration depth — more than one
subagent level, parallelism not opt-in per call; (3) provider-native paths,
because the openai-compatible abstraction is now carrying four workarounds.

**The duplicate confirm-post acceptance message is only half explained.** The
DM-fallback path definitely misbehaved (`replace_original` does nothing on an
ordinary DM message, so the outcome landed BESIDE a prompt whose buttons stayed
live) and that is fixed. A true ephemeral is replaced correctly, so if the
duplicate is still seen, grab the actual thread/DM and the timestamps: the
remaining possibility is the confirm going to BOTH the thread and the DM, which
the current code shouldn't do.

**Still worth doing on GitHub, now that the proxy exists:**
- A **GitHub App minting per-turn installation tokens** scoped to the repos the
  guard would allow. The proxy makes this a swap of what the host attaches, not
  a redesign — and it fixes "kyto has ONE GitHub identity", which is why the PAT
  got revoked in the first place.
- A **hard wall-clock ceiling per sandbox**, independent of activity. The reaper
  is activity-based, so a sandbox kept warm never ages out (the owner's own "if
  you get kyto to use wait and not pause sandbox?").

### Watch list

**DOES `gh`/`git` STILL WORK? (2026-08-06 — check this first.)** The write gate
moved to the HTTP layer and nothing in a sandbox holds a GitHub credential any
more. Verified end to end against real GitHub with gh 2.96 and git pointed at a
local instance of the proxy — read, clone, refused push, refused third-party PR
mutation, allowed write in kyto's namespace, anonymous fall-through — and the
deployed proxy answers correctly on `kyto.dino.icu`. What is NOT yet proven is
the E2B side: whether the sandbox image's own `gh` speaks the same GHES routing.
- `journalctl -u kyto.service | grep github-proxy` — refusals and upstream
  failures both log there.
- A `gh` call that fails with "unexpected response" or a 404 on `/api/v3/…`
  means the routing, not the guard.

**DID THE CACHING FIX WORK? (2026-08-05.)** The system prompt carried the current
time and the answered message's id, and it is sent as ONE string, so breakpoint A
(system + every tool schema, ~23k tokens) was invalidated on EVERY new turn.
Both moved to the volatile tail. Separately, `loadTools` growing the tools array
mid-turn invalidated the same prefix for the rest of that turn; a thread's loaded
set now survives the turn.
- `journalctl -u kyto.service | grep 'turn complete'` → `cache: {input, read,
  write}`. Read HIGH / input LOW across a thread's turns is the win.
- `journalctl -u kyto.service | grep 'prompt prefix changed'` — the probe
  (`packages/ai/src/cache-probe.ts`) logs any step whose prompt is not a pure
  APPEND of the previous step's, naming the unit that diverged.
- If read is still low on deepseek, the researched next step is OpenRouter's
  top-level `cache_control` — but don't add it blind, a wrong caching change only
  shows up on the bill.

**How often does `upgradeModel` fire, and does the stickiness cost too much?**
`journalctl -u kyto.service | grep 'model upgrade requested'`. Since 2026-08-06
an upgrade STICKS to its thread for 30 minutes of activity, and every sticky turn
claims a slot from the same 8-per-UTC-day cap — so the counter now measures
follow-ups as well as first asks. Too many → tighten `corePrompt`; the day's cap
running out early → shorten `STICKY_TTL_MS` rather than raising the cap.

**The mebbo tier is a hobby box.** `deepseek-v4-pro` and `gpt-oss-120b` verified
(real tool calls, ~0.1-0.5s first byte); `glm-5.2` and `kimi-k3-free` HUNG for
95s with no bytes, and 2 of 10 concurrent requests came back 400. It sits between
HackClub and Gemini. Watch whether it ever actually answers a live turn, and
whether the hangs spread to the two wired models.

**Does `submitEmoji` ever get the choice prompt?** Open to everyone since
2026-08-06, and it now waits up to 30s for the emoji bot's reply and hands it
back. The reported "upload as is / without background" Block Kit message is
EPHEMERAL to the poster and appears in none of the channel's last 200 messages —
kyto is the poster, a bot never receives ephemerals, and Slack has no API for
pressing a button on another app's message with a bot OR a user token. So when it
happens the tool reports "posted, not confirmed" plus a permalink. Watch the
journal for `[emoji] submitted` followed by no verdict; if it turns out to be
common, the answer is a human in `#emojibot`, not more code.

**The netic (`netic.hackclub.app`) key is DEAD as supplied (checked 2026-07-29).**
`GET /v1/models` answers 200 and lists all seven slugs, but every
`POST /v1/chat/completions` returns `401 Invalid API key`. Nothing was wired up.

**9Router + Kiro: do not use (researched 2026-07-29).** Kiro's own FAQ prohibits
"use with OpenClaw and similar tools that leverage third-party harnesses", which
is exactly what an OpenAI-compatible bridge is, and its terms separately prohibit
rate-limit evasion — which is what round-robining AWS Builder IDs is FOR.

**Free tiers worth trying instead, ranked (researched 2026-07-29).**
1. **NVIDIA NIM** — permanently free key, no card, ~40 RPM, tool calling
   confirmed on GLM-5 / DeepSeek V4 / Qwen3 / Kimi K2.6. Frontier-class open
   models, no expiring credits. Best structural fit.
2. **Cloudflare Workers AI** — built for low time-to-first-byte, the property
   that matters against HackClub's 5s header timeout. Smaller catalogue; good as
   a fast rung, not a primary.
3. **Groq** — famously fast first token, but its catalogue is where "llama 8b"
   lives; the ~6k TPM ceiling is tight against kyto's prompt.
Not worth it: Cerebras (~5 RPM), GitHub Models (8k input cap), DashScope
(90-day trial), DeepSeek direct (one-time grant), xAI data-sharing. OpenRouter's
free tier lost a third of its catalogue in nine days — don't hard-code a `:free`
slug as a rung.

**Deferred-tool data.** Every turn logs `[tools] turn summary` with `loaded` /
`loadedUsed` / `loadedUnused` / `coreUsed` — and `remembered` (carried in from an
earlier turn of the same thread). Promote anything always-loaded-and-used into
`core`; defer any core tool that never shows up in `coreUsed`; `loadedUnused` is
a round trip paid for nothing.

**The prompt is ordered for caching; watch that it holds.** The volatile blocks
(`<your_previous_thinking>`, the clock, the message id) sit BELOW the thread
history, so system + instructions + compacted + history is a stable append-only
prefix. A new block goes below `history` or the cache breaks silently.

**The ChatGPT account is parked until 2026-08-23** — it is on a FREE plan and its
quota is spent. Owner's note: that is his own linked account, and another user
linking a paid one works independently of it. A completed turn clears the park.

**HackClub sometimes serves opus-4.5 for a slug kyto never asks for** — a turn
came back `(Empty response: {'content': [], 'model': 'claude-opus-4-5…'})`. Kyto
filters the placeholder and falls back. Watch whether it recurs.

**HackClub's proxy 504s (reported to the HC AI team 2026-07-27).** Bursty, ~5.4s
every time, reproducible with bare `curl` — theirs, not ours. `gateway-retry.ts`
replays a gateway status twice and a 504 no longer condemns the tier. Watch
`[agent] gateway failure, retrying the same request` — retries EXHAUSTING means
the burst is worse than measured.

**Compaction is still unproven in the wild.** No thread has crossed 100 messages
(`MAX_THREAD_MESSAGES`) since it shipped. Check the first one that does: the
`<earlier_in_this_thread>` block should carry real decisions, and it runs on the
Gemini subagent key — if that key is unset the block degrades to a bare count.
The owner points at
https://hackclub.slack.com/archives/C0BDH1FNCTX/p1785766068566799 (~700 messages,
though that count includes kyto's own thinking blocks, which are not replayed as
thread messages — so it may still be under the cap).

**Status narration in the Thinking card — half explained.** A turn's Thinking
card showed plan/status text rather than reasoning. Audited: kyto never
classifies anything as reasoning, it arrives pre-separated in the provider's own
`reasoning_content` channel. Two candidates left: (a) the model genuinely wrote
that as its reasoning; (b) the card was truncated to its last fragment. The
"5 more steps (running)" half IS fixed — that row counted hidden tool cards and
hidden reasoning blocks TOGETHER; each kind now has its own row. Next time it
happens, grab the raw `fullStream` parts (`KYTO_LOG_FULLSTREAM=1`), not the
rendered card.

**Issue #2's feature ideas, folded in (kyto's own, worth keeping).** Not
started, listed shortest-leverage-first: per-CHANNEL customizations (merge order
channel → user → default, so a workspace rollout doesn't need everyone to
configure kyto individually); reminders FOR OTHER PEOPLE (`scheduleReminder`
only DMs the requester today — the recipient would get an opt-in the first time,
which the approvals feature already knows how to do); a memory-curation agent on
the existing `agent` reminder kind (memories have no dedup, staleness check or
pruning); site analytics + a `siteStats` tool; and memories that can carry an
attached folder of code rather than only prose, so a later thread can pull the
WORKING script back instead of re-deriving it. Issue #3 was `!secret` and is
now built — close it.

**The cache question, answered (2026-08-07).** Those Kimi K3 rows are one
turn's steps, and the shape is right: the expensive ones ($0.11-$0.13) are all
at the START and the cheap ones ($0.015-$0.02) all after, which is the cache
being written and then read. Turn-level numbers agree — `723,579 in / 658,816
cached` (91%), `282,047 / 268,288` (95%). The genuine miss was elsewhere and is
now fixed: `loadTools` grew the tools array mid-turn, tool schemas serialize
BEFORE the messages, so a newly visible tool landed in the MIDDLE and every byte
after it moved — `divergedAt: "tools(48)", cacheable: "0%"`, 22 turns in two
days, each paying full price for its whole remaining length.
`stabilizeToolOrder` now appends instead. Watch
`journalctl -u kyto.service | grep 'prompt prefix changed'`: it should go quiet.

**Compaction now reads the WHOLE thread (done 2026-08-08).** Your note — "the
compacter should see the full history, or if it is running the second or later
time, all history from the last compaction" — is exactly what shipped, and the
second half is what makes the first affordable. The read now STARTS at the
newest message the stored digest already covers (`fetchMessages`'s `oldest`), so
a thread's history is read once and every turn after that costs about the replay
window. The old cap of 400 is gone; the ceiling is 20,000 messages, and past
that kyto logs that it could not reach the tail. A backlog is split into passes
that each extend the previous digest and each SAVE, so a long-idle thread
catches up over a few turns instead of losing everything but the newest 200, and
more than one pass runs in the background so it never stalls a reply. The block
now counts the whole history, not the slice in hand, and says how much of it is
not digested yet.

The 1500-message thread will fix itself on its next turn: its stored digest
covers 298 messages, and the fetch will now start there and fold in the ~1,200
after it, six passes in the background. Watch
`journalctl -u kyto.service | grep '\[compaction\]'`.

**Your huge-thread question, answered — and it was not hypothetical.** The
thread kyto was struggling with, `C06QV2T1P4G:1710818631.730789`, is **25,000+
messages**, running since March 2024. Measured today.

If you mention kyto near the END of a thread that size, it sees your message
verbatim: the last 100 messages are always replayed in full, so nothing about
compaction can hide what you just said. What compaction changes is everything
OLDER.

The thread did expose a real hazard, now fixed. Slack can only page a thread
FORWARD, so a first read of 25,000 messages runs out of budget partway — and the
"last 100 messages" of a partial read are from the MIDDLE of the thread, i.e.
2024, replayed as if they were live. Kyto now notices the walk did not reach the
end, re-reads anchored a week before your message (which always reaches the
end), and says plainly that the thread is too long to see in full rather than
folding a slice that does not join onto its digest. That thread has a stored
digest, so it takes the cheap incremental path anyway: **3,718 messages since
its last compaction, 4 API calls instead of 25+**, folded in nineteen background
passes on its next turn.

**The `slack` CLI vs the `slackScript` tool, answered — and the CLI now explains
itself (2026-08-08).** They are not alternatives: `slackScript` is the TOOL that
runs a bash script in the sandbox, and `slack` is the COMMAND that script calls.
The same command is on PATH for the plain `bash` tool and for scheduled `bash`
reminders. Both go through the same host-side read-only proxy, so neither can
post anything and neither holds the Slack token.

What went wrong in the turn you pasted was smaller than it looked. The model
tried `slack conversations.replies --verbose '{...}'`; the helper takes exactly
two arguments, so `--verbose` became the request body, and the proxy correctly
answered `invalid_json_body`. The model read that as "conversations.replies is
not proxied" — it is, and always was — and spent three more steps guessing at
the argument format. So the helper now behaves like a real command: `slack
--help` prints the usage and every allowed method, a flag is rejected as a flag,
a method that is not proxied is named locally with the list, and a second
argument that is not valid JSON says so. The tool description and the sandbox
prompt now say "no flags, this is not curl and not the official Slack CLI".

**The docs described a runtime that no longer exists (fixed 2026-08-08).** README
and everything under `docs/` still described the Vercel Chat SDK, AI SDK Harness
and Pi — all removed in the rewrite — so pages like "Pi provides the coding
tools" were fiction on a public repo. README also pointed at
`imdevarsh/kyto-slack` for cloning and claimed MIT; it now points at
`Devansh-awat/kyto` and states AGPL-3.0. `docs/reference/harness.md` keeps the
phrase "coding agents" on purpose: there it means Claude Code, Codex and
OpenCode, which is what kyto is being compared against.

**Emoji uploads now happen DIRECTLY, the emojibot way (done 2026-08-09).** You
were right that emojibot's method is the one to copy, and there is no other:
Slack has NO public API for adding an emoji. `emoji.add` is an internal endpoint
that only accepts a browser session — an `xoxc-` token plus the matching `d`
cookie. So kyto now does exactly what that bot does, and the emoji is live
immediately instead of being posted into #emojibot and hoped for.

**It needs two values from you, once.** In a browser, open the workspace →
devtools (F12) → Network tab → add any emoji by hand → find the `emoji.add`
request. From it copy (a) the `token` form field, which starts `xoxc-`, and
(b) the `cookie` request header (or just the `d=xoxd-…` part of it). Put them in
`apps/bot/.env` as `SLACK_EMOJI_TOKEN` and `SLACK_EMOJI_COOKIE`, then restart.
Until they are set, `submitEmoji` behaves exactly as before.

Worth knowing what that pair is: **not a scoped token — your whole Slack
account.** It can read every DM you can and post anywhere as you, with no scopes
to narrow it and nothing distinguishing kyto from you in the audit trail. So it
stays in the env (never the database, never a sandbox, never a log), only
`addEmoji`/`removeEmoji` can touch it, and there is deliberately no general
"call Slack as the owner" helper built on it. Per your call, ANY user can add an
emoji with it — they all land under your name, so there is a 10/day/person cap
and every upload logs who asked. Removal is yours alone (Slack only lets the
adding account remove one). It dies when you log out of that browser session;
`invalid_auth` in the journal means re-copy it.

**Kyto is no longer told whose account an emoji goes in under (2026-08-11).**
Both places that said so are gone — the tool description told it to say so if
anyone asked, and the success message repeated it — so it can no longer volunteer
your name in a channel. It is still true and still in the journal; kyto just has
no reason to know. The same tool now tells it to prefer a cut-out image with a
TRANSPARENT background (no square backdrop, no border) and how to strip one in
the sandbox, since an emoji renders on whatever colour is behind it.

**The "38 more tool calls" bug is FIXED (2026-08-09) — here is what it actually
was.** Not a model problem. The visible-card budget (45 tool cards, 45 thinking
cards) lived in `renderStream` for the whole ATTEMPT, but a turn is not rendered
as one Slack message — it is several: `streamSegmented` cuts a new plan message
every time you get reply text followed by another tool card, and `harness.stream`
cuts one every 4.5 minutes because Slack stops accepting appends after ~5. So a
long turn spent all 45 slots inside its FIRST plan message, and every message
after that had nothing left to spend: only the overflow row could render. That is
exactly what you saw — a Thinking card, no tool cards at all, and a bare "38 more
tool calls". The budget now belongs to the caller and resets at both boundaries
(`lib/ai/stream/cards.ts`, tested). It also settles up before each message ends:
a card id only exists inside the message it was appended to, so anything still
mid-flight is completed there rather than left spinning forever.

**The raw `<｜DSML｜tool_calls>` in your reply: model, surfaced by the harness —
both halves now handled.** The model wrote its own tool-call markup into the TEXT
channel instead of the `tool_calls` field, which means the provider failed to
parse those calls: they were never executed, and the model kept retrying into a
void, which is why it repeated six times with one more character each. Kyto's
part was posting it. Anything from `<` + U+FF5C onward is now dropped from the
reply and logged with the cause (`lib/ai/stream/tool-markup.ts`, tested). The
underlying provider glitch is deepseek's, and the degenerate guard already
catches the loop once it becomes literal repetition.

**Slack search now falls back to your own token (done 2026-08-09).** Answering
"didn't we make it use the user token if the action token expired?" — no, we had
not; the grant requested `search:read` but `searchSlack` never used it. It does
now: the assistant action token still goes first (it is the only one that returns
surrounding context), and `invalid_action_token` retries on the user's own token
instead of reporting failure. A turn with no action token at all goes straight
there. Nobody else's token is ever used — the grant, or `SLACK_USER_TOKEN` for
you only, since that is your own credential. Someone with neither gets a connect
link rather than a dead end.

**OpenCode Zen: you were right, the free models work (done 2026-08-09).** Every
PAID slug still answers "No payment method", but the free ones need nothing.
Measured all eight with seven checks each (letter counting, the bat-and-ball
trap, a memoized-fib one-liner, weekday arithmetic 100 days back, exact
instruction following, compact JSON, one real tool call):

| model | score | avg |
|---|---|---|
| `big-pickle` | 7/7 | 8.5s |
| `deepseek-v4-flash-free` | 7/7 | 9.5s |
| `longcat-2.0-free` | 7/7 | 11.3s |
| `nemotron-3-ultra-free` | 6/7 | 17.0s |
| `mimo-v2.5-free` | 5/7 | 10.2s |
| `laguna-s-2.1-free` | 4/7 | 12.9s |
| `north-mini-code-free`, `ling-3.0-flash-free` | upstream 500 | — |

Your hunch about big-pickle was right — it is both the smartest and the fastest.
The three 7/7 models are wired in that order, below mebbo and above Gemini as you
asked. `deepseek-v4-flash-free` is literally the primary model, free, on a
different provider, which makes it a good HackClub-outage rung. The reason it
sits low is not money: their terms let free-tier traffic train the model, and a
kyto turn carries other people's Slack messages.

**Coolton's whiteboard, copied and improved (done 2026-08-09).** It is not a
whiteboard feature at all — it is a Slack **`video` block**, which iframes any URL
right inside the message and lets people interact with it. Coolton points it at
felix's hosted tldraw (`whiteboard.felix.hackclub.app/{random}`) and uses the same
trick for arbitrary HTML on their own file server. Kyto already hosts sites, so
it now serves the page ITSELF: one domain, no third party, and the page dies when
kyto says so. The new `embed` tool posts either a self-contained HTML page kyto
wrote or a tldraw whiteboard; re-publishing the same id swaps what an existing
message shows.

- **Needs a reinstall** — the manifest now asks for `links.embed:write` and
  `links:read`, and registers `kyto.dino.icu` as the only unfurl domain (Slack
  requires both, and keeping it to one domain means kyto can never be talked
  into embedding an arbitrary site). DONE!

**The whiteboard is real, and it is Excalidraw now (2026-08-11).** What you saw
— it loads then dies — was tldraw's licence enforcement, reproduced in a
headless browser: their `LicenseProvider` blanks the whole editor **5 seconds**
after load on any host that is not localhost, and their licence says outright
"Not to use the Software in Production Environments" without a paid key, plus
not to interfere with the key check (so pinning the old 3.7.0, which only
watermarked, is not a way round it either).

So the canvas is Excalidraw: MIT, no key, no gate, no watermark, and yours to
modify. The multiplayer is ours rather than a vendor's — four messages, and the
one rule that matters (which copy of a shape wins) lives in one tested file that
both the server and the browser import, because two versions of that rule
disagreeing is exactly how a shared board silently forks. Verified end to end on
the live host: two browsers, one draws a rectangle, the other shows it, the
cursor badge counts the other person, and it is still there after a
`systemctl restart`.

**How coolton did it, since you asked: they didn't.** `send_whiteboard_embed`
is 22 lines — pick `random.randint(100000, 999999)`, point a Slack video block
at `https://whiteboard.felix.hackclub.app/{that number}`, done. No hosting, no
sync, no persistence: felix's server does all of it, and coolton just links to
it. Which also means the licence problem is felix's, not theirs — his instance
is tldraw 5.0.0, and it still renders today (I checked), so whatever changed in
tldraw's enforcement landed after 5.0. Kyto could have done the same thing in an
afternoon; the reason it doesn't is that it would put every board kyto posts on
someone else's box, under their uptime and their rules.

**OpenCode Zen is REMOVED — you are right about training (2026-08-11).** Their
free tier's terms let the traffic improve the model, HC's scraping policy allows
training on Slack messages only with every author's explicit consent, and a kyto
turn carries other people's messages. No position in the fallback queue makes
that OK, so the tier is gone rather than demoted — the queue is an allowlist of
tiers, and there is now a test saying a provider nobody chose is dropped, not
tried last. `OPENCODE_API_KEY` is no longer read.

**Forkie (toeknee-top/Forkie), checked 2026-08-11 — mostly compliant, two real
defects.** It is a genuine fork of kyto with shared history, the `LICENSE`,
`LICENSE-gorkie-MIT` and `NOTICE` files are byte-identical to ours, your
copyright line is intact, and both the README and `AGENTS.md` say it is forked
from kyto and link this repo. But:
- **Its README's own License section says "This project is under the MIT
  license"**, contradicting the AGPL-3.0 `LICENSE` file sitting next to it. They
  cannot relicense AGPL-derived code that way, so it reads as a copy-paste
  slip — but anyone trusting the prose is being told they have rights they do
  not have.
- **The deployed bot still points users at OUR repo as its source.**
  `prompts/slack.ts` and `core.ts` are untouched, so it still says "You're Kyto"
  and hands out `github.com/Devansh-awat/kyto`. Only the owner-grounding line
  carries their name. Since Forkie's code genuinely differs, AGPL §13's
  network-source obligation is not met by that link.
Both are one-line fixes on their side; worth a friendly message rather than
anything heavier.

What they ADDED is one feature: a config-driven sandbox provider
(`createSandbox()` → SSH to your own box → E2B → in-process local), so the bot
can run without an E2B account. Nothing else — no new tools, no new features, no
routing changes. Note for us: they forked BEFORE the GitHub proxy, their new
sandbox backends never receive `GIT_HARDEN_COMMAND` or a GitHub token, and
`LocalSandbox` runs model-driven shell commands in the bot's own container. The
provider abstraction is worth stealing if kyto ever wants an E2B-optional path,
but only after wiring those two in. Their code comments also mention a
"QuackX" — there may be a third kyto fork about.

**Per-channel customization shipped (2026-08-21) — and one half of it is not built yet.** MCP servers can be shared with a channel or a channel group, memories can be promoted into one, and channel groups exist so a share covers 5-7 rooms at once. What is NOT done from the older "per-CHANNEL customizations" idea is the per-channel PROMPT (the `user_customizations.prompt` merge order channel → user → default). That is a separate, smaller change: `requestHints` already has the channel id and the group ids in scope, so it needs a `channel_customizations` table and a merge, nothing more.

**Two things about sharing worth watching now that it is live.**
- A share with a GROUP follows the group. Its creator can add a channel later, and everyone's shares extend to it. The App Home copy says so, but nobody reads copy — if this ever bites, the fix is to make a group's channel list changeable only by its creator AND notify the people who have shared into it.
- Watch `journalctl`/`docker logs` for `[mcp] shares updated` and `[channel-groups] updated` to see whether anyone actually uses it, before building more on top.

**From the comprehensive safety review (2026-08-21) — what is FIXED.** Full write-up in the chat; the short list, so it is not re-found later:
- `poll` could ping a whole channel. Its options are model text rendered as an mrkdwn section (the one Slack surface that resolves `<!channel>`) and it posts with `chat.postMessage` directly, so it never met the broadcast strip. Open to everyone, and reachable unattended through an `agent` reminder. Neutralized in `buildPollBlocks`.
- An interrupt burst merged messages from DIFFERENT people under the last sender's identity — so a stranger's text could run at owner privilege. Now merges only the trailing same-author run (`lib/agent/steering.ts`, tested).
- MCP server URLs had no SSRF guard: anyone could point one at `169.254.169.254` or a neighboring container and read the reply out of their own thread. Checked on save and again at connect time with a DNS resolve.
- `slackScript` was a FIFTH shell with neither the GitHub guard nor the git-repo disarm. `codeMode` and `bash` reminders were missing the disarm too.
- `git -C /repo push` parsed as verb `/repo`, so it was never flagged as mutating (the HTTP proxy still refused it; the local guard did not).
- `setChannelTopic` could be aimed at ANY channel by id, by anyone. Now non-owners can only touch the channel kyto was invoked in.
- A non-owner's `postMessage` no longer starts a top-level message — it lands in the invoking thread. This is the honest answer to "messaging in other channels where ppl cant type": Slack exposes no API for a channel's posting restrictions, so kyto puts the message where the asker demonstrably could have put it themselves.
- A named reminder EDITOR can no longer change a reminder's `kind`/`command`/`url`. A reminder fires as its creator, so that was a way to run your instructions at someone else's permission level, on a timer.
- `thread.schedule()` now strips broadcasts like `post` does (was inert, but it was one caller away from not being).

**What the review did NOT find a way to do**, for the record: reach another user's MCP server or credential, promote a memory as anything but the owner, get a decrypted BYOK/ChatGPT/Slack-grant secret into a log, prompt, sandbox or modal, search Slack as somebody else, read an email with its credentials intact, or get a GitHub credential into a sandbox. The command-text GitHub guard IS defeatable several ways (quoting, `$( )`, base64+eval, dynamically-built commands) but every one of them still has to transit the host proxy, which classifies the real HTTP request — that is working as designed, and the local guard is a UX layer.

**Still open from the review — decide these.**
- `browser` downloads are never disarmed. Low risk (extracting or cloning through any shell triggers the disarm), but it is the one gap left in that control.
- Nothing anywhere reads a channel's posting restrictions, because Slack has no API for it. The thread-redirect above is a mitigation, not a check.

**Link rendering fixed (2026-08-21).** Both cases you saw were the same bug: Slack's `markdown` block auto-links a bare URL by running to the next whitespace and does not stop at a markdown delimiter, so the closing `**` and a following backtick were eaten INTO the href. A URL touching `*`, `_`, `~` or a backtick is now rewritten as an explicit `[url](url)` before posting (`disambiguateBareUrls`, tested). Only the ambiguous ones — a plain bare URL still posts bare, because Slack unfurls those and an explicit link loses the preview.

**`.claude/CLAUDE.md` is ~49k characters against its own 40k budget.** It was already 44.7k before this pass. Worth a dedicated trim: the security-invariants list and the identity/gating list are each several thousand characters of prose that could move into TOOLS.md behind a pointer, the way MODELS.md and STREAMING.md already work.