# Kyto TODO

## When something is done, remove it from here
## how this works: i put my ideas, problems, etc here, then every 2 or so days i ask claude(you) to fix it. I also leave notes between the stuff you put here.

### Open

**Move the GitHub write gate to the HTTP layer** — owner's call, 2026-07-29
("yeah move gaurd to http layer"). The trigger was the owner's own question:
"if you get a shell into kyto, you can use its gh and do stuff right? … remote
shell are not easy to stop, you block sshx one will use tmate". He is right, and
the token being unextractable does not help: the E2B egress rule staples
`Authorization` onto EVERY github.com request out of the sandbox, so any process
in the box — kyto tool or not — is already authenticated as `kyto-agent`.
`guardGithubCommand` only ever sees strings that came through a kyto TOOL, so
sshx/tmate, a shell script, or `sh -c 'g''h …'` never meets it.

**DECISION 2026-08-01 (owner): build stop-brokering + a host-side proxy, NO
egress deny.** `denyOut` CANNOT take domains (the E2B schema is explicit:
"Domain names are not supported for deny rules"), and it turns out not to be
needed — the token-abuse hole closes simply by NOT BROKERING THE TOKEN. Today
the real PAT lives ONLY in the egress header-injection rule (the sandbox-visible
`GH_TOKEN` is a base64 placeholder). Remove that rule and no sandbox process has
it; a direct `curl github.com` is anonymous, which is fine for public reads and
useless for writes. The real token then lives only host-side in the proxy, which
kyto's own gh/git are pointed at and which enforces the parsed-request guard.
Accepted trade: this bakes ONE principal per sandbox lifetime (vs per shell
command), which matches the already-single-user-per-thread sandbox.

Build plan (still to do — a standalone pass):
1. `apps/bot/src/lib/github-proxy/index.ts` — `handleGithubProxy(req, pathname)`
   mounted at `/_ghapi/` on the sites Bun.serve (beside `handleSlackProxy`).
   Per-turn token stores `{userId, isOwner, threadId, expiry}` so it can feed the
   guard. Classify method+path (writes = POST/PUT/PATCH/DELETE to /repos/..,
   /user/repos, /orgs/.., graphql `mutation`; else read) → call
   **`guardGithubTargets`** (already extracted for exactly this) → forward to the
   real host with the PAT attached host-side → on 2xx call `claim()`. Must handle
   git smart-HTTP (`info/refs?service=git-upload-pack` / `git-receive-pack`), not
   just REST.
2. `packages/sandbox/src/lazy-sandbox.ts` — stop calling `githubNetwork()`, drop
   the placeholder `GH_TOKEN` env; keep GIT_ASKPASS/GIT_TERMINAL_PROMPT. Add an
   idempotent bootstrap step (same slot as GIT_HARDEN_COMMAND) setting `GH_HOST`
   + `git config --global url."<proxy>/".insteadOf`, fed the per-turn proxy token
   via per-command env (the Slack-proxy pattern).
3. Preserve every guard invariant: ownership → trust → claim-on-success-only,
   `github_requests` queueing, dead-PAT falls open to anonymous public reads,
   **and the new collaborator exception** (`lib/github/collaborator.ts`).
4. TEST live: sandbox has NO real token, gh/git route through the proxy, a
   third-party write is gated + queued, a public read works.

Adjacent, still unrecorded elsewhere:
- A **GitHub App minting per-turn installation tokens** scoped to the repos the
  guard would allow is the durable answer — it also fixes "kyto has ONE GitHub
  identity", which is why the PAT got revoked in the first place.
- A **hard wall-clock ceiling per sandbox**, independent of activity. The reaper
  is activity-based, so a sandbox kept warm never ages out (the owner's own "if
  you get kyto to use wait and not pause sandbox?").

**Reduce the system prompt.** Asked 2026-07-28 and still not attempted. Measure
the assembled prompt first; it is paid on every turn of every thread against the
shared $3/day. Note this got LESS urgent on 2026-08-05: the system prompt is now
stable across a thread's turns, so it should be a cached read rather than a
full-price one — measure the cache first, then decide if trimming is still worth
it.

**`@kyto?focusmode @person` — needs one clarification before building.** The ask
(2026-08-05) was: "if anyone send msg @kyto?focusmode @person (proper mentions)
then it do focusmode without interupiting kyto". Two readings, and they build
differently: (a) a COMMAND PREFIX — a message matching `@kyto?<command> …` is
handled by the harness directly (set focus, no model turn, and no interruption
of a turn already running); or (b) simply "turning focus on must not abort the
in-flight turn". Ask before building.

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

**`submitEmoji` is owner-only, and that is a stopgap.** Submitting an emoji puts
a FILE into a channel kyto was not invoked in — exactly the shape the confirm
gate exists for — and `PendingPost` has no way to hold a file. Opening it to
everyone means teaching the APPROVAL gate a new kind whose payload is
`{threadId, path, name}` and which reads the file back at approve time. Worth
doing; say so if you want it.

### Watch list

**DID THE CACHING FIX WORK? (2026-08-05 — check this first.)** Two real bugs
were found and fixed. The system prompt carried the current time (to the
millisecond) and the id of the message being answered, and it is sent as ONE
string, so breakpoint A (system + every tool schema, ~23k tokens) was
invalidated on EVERY new turn — only the within-turn steps ever hit, which is
exactly the ~22.8k-cached-of-78k pattern in the activity dump. Both moved to the
volatile tail of the user message. Separately, `loadTools` growing the tools
array mid-turn invalidated the same prefix for the rest of that turn; a thread's
loaded set now survives the turn, so a repeat thread stops churning it.
- `journalctl -u kyto.service | grep 'turn complete'` → `cache: {input, read,
  write}`. Read HIGH / input LOW across a thread's turns is the win.
- `journalctl -u kyto.service | grep 'prompt prefix changed'` — the new probe
  (`packages/ai/src/cache-probe.ts`) logs any step whose prompt is not a pure
  APPEND of the previous step's, naming the unit that diverged and the share of
  the request that could still be cached. That is the "record the raw stuff we
  send to the api to see where it differs" ask, made permanent.
- If read is still low on deepseek, the researched next step is OpenRouter's
  top-level `cache_control` (it auto-advances the breakpoint for multi-turn) —
  but don't add it blind, a wrong caching change only shows up on the bill.

**How often does `upgradeModel` fire?** New 2026-08-05, and the counter exists to
tune the prompt: `journalctl -u kyto.service | grep 'model upgrade requested'`.
Too many → tighten the wording in `corePrompt`; none at all → loosen it. The
rungs are kimi-k3 then claude-sonnet-5, ~20-50x the primary on the same $3/day
cap, capped at once per turn and 8 per UTC day workspace-wide.

**The mebbo tier is a hobby box.** `deepseek-v4-pro` and `gpt-oss-120b` verified
(real tool calls, ~0.1-0.5s first byte); `glm-5.2` and `kimi-k3-free` HUNG for
95s with no bytes, and 2 of 10 concurrent requests came back 400. It sits between
HackClub and Gemini. Watch whether it ever actually answers a live turn, and
whether the hangs spread to the two wired models. Owner also mentioned opencode
running on that box ("we can get a bit more free requests from it, using the api
which i think it has") — not investigated; there is an unused `OPENCODE_API_KEY`
already declared in `packages/ai/src/keys.ts` if that turns into something.

**The netic (`netic.hackclub.app`) key is DEAD as supplied (checked 2026-07-29).**
`GET /v1/models` answers 200 and lists all seven slugs, but every
`POST /v1/chat/completions` returns `401 Invalid API key` — tested on all seven,
directly against https so it is not a redirect stripping the header. Nothing was
wired up: no tier without a live account behind it. Ask for a working key.

**9Router + Kiro: do not use (researched 2026-07-29).** Kiro's own FAQ prohibits
"use with OpenClaw and similar tools that leverage third-party harnesses", which
is exactly what an OpenAI-compatible bridge is, and its terms separately prohibit
rate-limit evasion — which is what round-robining AWS Builder IDs is FOR.

**Free tiers worth trying instead, ranked (researched 2026-07-29).** Answering
the owner's "do they have good models, for free? i don't want stuff like llama
8b": yes for 1 and 2, with caveats.
1. **NVIDIA NIM** — permanently free key, no card, ~40 RPM, tool calling
   confirmed on GLM-5 / DeepSeek V4 / Qwen3 / Kimi K2.6. Those are frontier-class
   open models, not small ones. Best structural fit; no expiring credits.
2. **Cloudflare Workers AI** — built for low time-to-first-byte, the property that matters
   against HackClub's 5s header timeout. Catalogue is smaller and more
   mid-sized; good as a fast rung, not as a primary.
3. **Groq** — famously fast first token, but its catalogue is where "llama 8b"
   actually lives; the ~6k TPM ceiling is also tight against kyto's prompt.
Not worth it: Cerebras (~5 RPM), GitHub Models (8k input cap), DashScope
(90-day trial, duplicates qwen), DeepSeek direct (one-time grant), xAI
data-sharing (pays in user conversation content). OpenRouter's free tier lost a
third of its catalogue in nine days — don't hard-code a `:free` slug as a rung.

**Deferred-tool data.** Every turn logs `[tools] turn summary` with `loaded` /
`loadedUsed` / `loadedUnused` / `coreUsed` — and now `remembered` (carried in
from an earlier turn of the same thread, so the measurement stays honest).
Promote anything always-loaded-and-used into `core`; defer any core tool that
never shows up in `coreUsed`; `loadedUnused` is a round trip paid for nothing.

**The prompt is ordered for caching; watch that it holds.** The volatile blocks
(`<your_previous_thinking>`, the clock, the message id) sit BELOW the thread
history, so system + instructions + compacted + history is a stable append-only
prefix. A new block goes below `history` or the cache breaks silently.

**The ChatGPT account is parked until 2026-08-23** — it is on a FREE plan and its
quota is spent; the 429 named that date and it is stored in
`user_chatgpt_accounts.quota_resets_at`. Owner's note: that is his own linked
account, and another user linking a paid one works independently of it. A
completed turn clears the park automatically.

**HackClub sometimes serves opus-4.5 for a slug kyto never asks for** — a turn
came back `(Empty response: {'content': [], 'model': 'claude-opus-4-5…'})`. Kyto
filters the placeholder and falls back; whether HackClub remaps slugs upstream is
their question. Watch whether it recurs.

**HackClub's proxy 504s (reported to the HC AI team 2026-07-27).** Bursty, ~5.4s
every time, reproducible with bare `curl` — theirs, not ours. `gateway-retry.ts`
replays a gateway status twice and a 504 no longer condemns the tier. Watch
`[agent] gateway failure, retrying the same request` — retries EXHAUSTING means
the burst is worse than measured.

**Compaction is still unproven in the wild.** No thread has crossed 100 messages
(`MAX_THREAD_MESSAGES`) since it shipped. Check the first one that does: the
`<earlier_in_this_thread>` block should carry real decisions, and it runs on the
Gemini subagent key — if that key is unset the block degrades to a bare count.

**Status narration in the Thinking card — half explained.** A turn's Thinking
card showed plan/status text rather than reasoning. Audited: kyto never
classifies anything as reasoning, it arrives pre-separated in the provider's own
`reasoning_content` channel. Two candidates left: (a) the model genuinely wrote
that as its reasoning (a prompt/model issue); (b) the card was truncated to its
last fragment. The "5 more steps (running)" half IS fixed — that row counted
hidden tool cards and hidden reasoning blocks TOGETHER, so a plan whose tool
cards had all overflowed read as kyto narrating step counts; each kind now has
its own row. Next time it happens, grab the raw `fullStream` parts
(`KYTO_LOG_FULLSTREAM=1`), not the rendered card.
