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

**OpenCode Zen: the key is live but the workspace has no payment method
(checked 2026-08-07).** `POST /zen/v1/chat/completions` answers
`CreditsError: No payment method. Add a payment method here:
https://opencode.ai/workspace/wrk_01KZDEPA5DNS77JSY81HCT6HKN/billing`. So the
API tier is not free without billing attached. Your note — "opencode command
runs without needing key" — is the interesting half: the CLI is authenticated
separately (its own login), so it can reach models the raw API key can't. That
is a DIFFERENT transport, not an OpenAI-compatible endpoint, so wiring it would
mean shelling out to `opencode run` from the host and parsing its output — it is
an agent harness, not a completions API, and it runs on the box rather than in a
sandbox. Worth deciding deliberately rather than sliding into: say the word and
it can be measured, but it is not a drop-in rung.

**Is deepseek-v4-pro better than the v4-flash primary?** Asked 2026-08-06, not
answerable yet: pro is reachable on mebbo, but a fair comparison needs the same
prompts through both and a look at first-byte latency, which is what actually
loses turns against HackClub's 5s header timeout. Worth doing as its own pass —
flash was picked partly BECAUSE it answers fast, so "pro is smarter" alone does
not settle it.

**Finish what the Slack OAuth grant unlocks.** The grant itself shipped
2026-08-07 (`lib/slack-oauth`, `user_slack_grants`) and `!secret` uses it. The
scopes already requested cover the rest of what you asked for, and each is its
own piece of work:
- **search as the user** — `searchSlack` currently uses kyto's assistant token,
  which expires every couple of minutes; with a grant it can use `search:read`
  on their own token and see their channels.
- **send as the person who asked**, with THEIR confirm click. The machinery
  exists: the confirm-post gate already routes a mirrored post to the person
  being mirrored (`approverUserId`). This would make that real rather than an
  impersonation of them by the owner's token.
- **reading a private channel or DM needs their approval per use** — the grant
  is consent to the capability, not to any particular read. Wire it through the
  same confirm gate.

**`!secret` is now configured and live (2026-08-07).** Client id/secret are in
`apps/bot/.env`, the manifest is pushed (redirect URL + the three history user
scopes), and `https://kyto.dino.icu/_slackauth/callback` answers. `sync:manifest`
now writes the rotated token pair back to `.env` — a refresh token is single-use,
and only printing the replacement is what left a dead one behind and drifted the
live config from the repo. **Remaining: reinstall the app** so the workspace
grants the new user scopes, then connect your account from App Home.

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

**Compaction on the 1500-message thread WORKS, with one real limit
(checked 2026-08-07).** `slack:C0BDH1FNCTX:1785766068.566799` carries a
1,648-char summary covering 298 messages. But `MAX_COMPACTION_MESSAGES` is 400
and `MAX_THREAD_MESSAGES` is 100, so kyto fetches at most the last 400 and folds
~300 of them — everything older than that is not summarized, it is simply never
seen. At 1500 messages that is ~1100 invisible. The block's count is honest
about what it covers, but it does NOT say "and there are 1100 more". Two options
when you want to fix it: raise the fetch cap (more Slack API calls per turn), or
make the summary genuinely running by folding each batch into the previous
summary as the thread grows past 400. The second is the right one.
regarding this, compacter should see the full history, or incase compaction is running the second or later time, all history from the last compaction

what is the difference betweek slackscript tool and slack cli, and maybe we should tell model how to use as this happens
Running commandcd /home/user && slack conversations.replies '{"channel":"C06QV2T1P4G","ts":"1710818631.730789"…
Error: The socket connection was closed unexpectedly. For more information, pass `verbose: …
ThinkingHmm, the slack proxy may be having issues. Let me try a simpler call.
Running commandcd /home/user && slack conversations.replies '{"channel":"C06QV2T1P4G","ts":"1710818631.730789"…
Completed.
ThinkingHmm, empty output with exit code 0. Let me check verbose.
Running commandcd /home/user && slack conversations.replies --verbose '{"channel":"C06QV2T1P4G","ts":"17108186…
Completed.
Thinkinginvalid_json_body. Hmm, maybe the ts field format. Let me try with the slashes url format. Actually the previous turn suggested using chat SDK ids. The readConversationHistory tool works. But for aggregate counting, I need the API directly.

The slack CLI with conversations.replies gives invalid_json_body. Maybe the channel needs to be C... and ts as string. Let me try different arg format. Maybe it expects the args differently. Let me check how slack CLI works. Let me try slack conversations.replies '{"channel":"C06QV2T1P4G","ts":1710818631.730789}'. The ts as float.

Actually invalid_json_body suggests JSON parse error. Maybe the CLI takes args differently, like separate. Let me check the slack CLI usage.
Running commandcd /home/user && slack --help 2>&1 | head -40; echo "==="; slack conversations.replies '{"chann…
Completed.
ThinkingThe slack CLI seems to only allow certain methods (read-only proxy). conversations.replies maybe not allowed/not proxied. Let me use the slackScript tool instead, which runs a read-only bash script against the Slack API. Let me load it.

Actually, let me check what methods the slack CLI supports by trying to see. Let me use slackScript tool. Load tools first.

secondly i mentioned it in a 1mil message thread(not in orignal post but later near end) would it compact then?

remove anything saying coding agent from the docs, and fix README.md as i think they say imdevarsh repo