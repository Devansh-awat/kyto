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

**OpenCode Zen needs a key.** `GET https://opencode.ai/zen/v1/models` answers
anonymously and lists claude-opus-5, opus-4.8/4.7/4.6, sonnet-5, fable-5 and
friends — a genuinely strong catalogue — but every completion needs auth and
`OPENCODE_API_KEY` is unset (the var is already declared in
`packages/ai/src/keys.ts`). Paste a key and it can be measured like mebbo was:
tool calls, first-byte latency, and whether the free plan actually covers it.
me put the key. but opencode command runs without needing key.

**Is deepseek-v4-pro better than the v4-flash primary?** Asked 2026-08-06, not
answerable yet: pro is reachable on mebbo, but a fair comparison needs the same
prompts through both and a look at first-byte latency, which is what actually
loses turns against HackClub's 5s header timeout. Worth doing as its own pass —
flash was picked partly BECAUSE it answers fast, so "pro is smarter" alone does
not settle it.

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

check the two issues kyto made #2 and #3 and add them. 

some cache miss here?
4m ago • i	Kimi K3	43,226 in / 173 out	$0.02721	OK · 7.8s
4m ago • i	Kimi K3	43,113 in / 75 out	$0.025401	OK · 9.3s
4m ago • i	Kimi K3	43,009 in / 66 out	$0.024954	OK · 6.2s
4m ago • i	Kimi K3	42,490 in / 481 out	$0.029622	OK · 16s
4m ago • i	Kimi K3	42,350 in / 79 out	$0.023172	OK · 6.1s
5m ago • i	Kimi K3	42,247 in / 51 out	$0.022443	OK · 5.7s
5m ago • i	Kimi K3	42,134 in / 75 out	$0.022464	OK · 6.3s
5m ago • i	Kimi K3	42,030 in / 66 out	$0.022017	OK · 5.9s
5m ago • i	Kimi K3	41,666 in / 326 out	$0.024825	OK · 14s
5m ago • i	Kimi K3	41,184 in / 61 out	$0.019404	OK · 6.5s
5m ago • i	Kimi K3	41,068 in / 73 out	$0.019236	OK · 6.8s
6m ago • i	Kimi K3	40,965 in / 65 out	$0.018807	OK · 5.1s
6m ago • i	Kimi K3	40,526 in / 401 out	$0.02253	OK · 16s
6m ago • i	Kimi K3	40,281 in / 62 out	$0.01671	OK · 6.7s
6m ago • i	Kimi K3	39,947 in / 83 out	$0.016023	OK · 6.3s
6m ago • i	Kimi K3	39,844 in / 65 out	$0.015444	OK · 6.4s
6m ago • i	Kimi K3	39,507 in / 299 out	$0.017943	OK · 14s
7m ago • i	Kimi K3	39,081 in / 233 out	$0.032264	OK · 10s
7m ago • i	Kimi K3	38,881 in / 63 out	$0.07888	OK · 8.2s
7m ago • i	Kimi K3	38,525 in / 207 out	$0.114187	OK · 11s
7m ago • i	Kimi K3	38,758 in / 51 out	$0.117039	OK · 14s
8m ago • i	Kimi K3	38,775 in / 538 out	$0.124395	OK · 31s
8m ago • i	Kimi K3	40,868 in / 187 out	$0.125409	OK · 23s
9m ago • i	Kimi K3	40,462 in / 349 out	$0.018189	OK · 9.2s
9m ago • i	Kimi K3	39,359 in / 763 out	$0.129522	OK · 28s