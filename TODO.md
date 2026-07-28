# Kyto TODO

## When something is done, remove it from here
## how this works: i put my ideas, problems, etc here, then every 2 or so days i ask claude(you) to fix it. 

### Open

**`Invalid prompt` burns the whole fallback chain in seconds.** Observed
2026-07-28 12:18 in `slack:C0BDH1FNCTX:1785240750.304839`: `Invalid prompt: The
messages do not match the ModelMessage[] schema. Type validation failed` on a
message whose content starts with the `<your_previous_thinking>` block. It hit
kimi-k2.7-code → kimi-k2.6 → minimax-m3 in **28 seconds**, identically — a
malformed prompt is malformed for every model, so falling back cannot rescue it
and just spends three rungs of the shared budget proving that. Two things to
fix, probably separately: (1) whatever in `buildPrompt`/`thinking.ts` emits a
message that fails the SDK's `ModelMessage[]` schema, and (2) the routing should
recognise a prompt-construction error as *ours* and NOT walk the fallback queue
at all — `canContinue`/the fallback decision currently treats it like a provider
death. 4 of 11 mid-stream errors in a 33h window were this.

**Going public is now only blocked on two small licence checks.** The
gorkie-provenance question is MEASURED (2026-07-26, blame-based, in
`docs/reference/publishing.md`): ~16% of runtime source lines are still
gorkie-derived, so the MIT carve-out stays — that decision is made. Skills
provenance is documented (8 pinned in `skills-lock.json`, 2 first-party); two
skills need their upstream licence confirmed or dropping before the flip
(`ai-sdk` — GitHub reports "Other"; `thermo-nuclear-code-quality-review` —
`cursor/plugins` has no detectable licence). Then rotate `GH_TOKEN` and re-run
the secrets scan.

**"Thinking..." shows as plain text before the plan block appears**, and when
the block does appear it already has thinking in it. Investigated: no such
string exists anywhere in kyto, and the first plan chunk is already pulled
before the stream opens, so this looks like Slack's own placeholder for an open
`chatStream` that has not rendered yet. Needs confirming against a real thread
before there's anything to fix. Ideally show a real loading message instead.

**Thinking cards render as a single line.** Worth confirming this is genuinely
one line of reasoning (gpt-5.6 returns short `reasoningSummary` text, so it
probably is) rather than longer thinking being truncated somewhere. Try again
and look at the raw response.

**Next harness upgrades** — the original three (edit + diagnostics, thread
compaction, tests over the crown jewels) are done as of 2026-07-27. What the
assessment named and nobody has touched: (1) loop control — a plan/approve
checkpoint and budget-aware pacing, since `MAX_STEPS=1000` leaves the watchdog
as the only real governor; (2) orchestration depth — more than one subagent
level, parallelism not opt-in per call; (3) provider-native paths, because the
openai-compatible abstraction is now carrying four separate workarounds.

### Watch list

**The ChatGPT account is parked until 2026-08-23.** The linked account is on a
FREE plan and its quota is spent; the 429 named that reset date, which is now
stored in `user_chatgpt_accounts.quota_resets_at` and the attempt is skipped
until then. If ChatGPT turns are wanted before that, the account needs a paid
plan. A completed turn clears the park automatically.

**HackClub sometimes serves opus-4.5 for a slug kyto never asks for** — a turn
came back `(Empty response: {'content': [], 'model': 'claude-opus-4-5…'})`.
Kyto already filters the placeholder and falls back; whether HackClub remaps
slugs upstream is their question. Watch whether it recurs.

**The DigitalOcean tier is gone (2026-07-27)** — the account behind it stopped
being provided, so the whole `openrouter-do` tier, its key, and both of its
write-offs were deleted from kyto, and the same dead key was removed from
`stardance-archive` (its `gemini` embedder now calls Google directly; same model,
same 3072 dims). Fallback is HackClub then the owner's Gemini key, with nothing
free in between — so watch how often `BudgetExhaustedError` actually shows up
now that HackClub's daily $3 is the only shared tier.

**HackClub's proxy 504s (reported to the HC AI team 2026-07-27).** Bursty, ~5.4s
every time, size- and shape-independent, reproducible with bare `curl` — theirs,
not ours. Three things now sit between it and a user: `gateway-retry.ts` replays
a gateway status twice; a 504 no longer condemns the whole HackClub tier
(`condemnsHackclub`); and the tier it falls back to is kimi-k2.6 then
minimax-m3, both cheaper than the primary. Watch `[agent] gateway failure,
retrying the same request` in the journal — retries EXHAUSTING means the burst is
worse than measured. Also watch what the cheap rungs actually produce in public:
they are now the only thing between the primary and Gemini, and nobody has read a
k2.6 or m3 answer in a live thread yet.

**Compaction is new and unproven in the wild (2026-07-27).** No thread has
crossed 100 messages since it shipped. Check the first one that does: the
`<earlier_in_this_thread>` block should carry real decisions, and the summarizer
runs on the Gemini subagent key — if that key is ever unset the block degrades to
a bare count, which is intended but worth seeing once.
100+msg or a certain token count

Kyto eats up the 3$ quota too fast, use Qwen3.7 Plus as a model, and see if deffered tools help, as it means one more tool call and more requests. maybe reduce system prompt too. discus options with me using ask question tools. make sure we have all cache hits of resued stuff, check if we are doing it correctly. maybe for tool output, it should truncate it signifacntly more when a new msg is send, what i mean is tool output of first turn does not need to be sent fully and can be truncated a bit before next turn. 

my freind sent this can we use it :ms-robot: :ms-robot: Best Free AI setup!!!  By @hiddenhorseylarper
1. Install 9Router - find the instructions on the repository: https://github.com/decolua/9router
2. Install OpenCode - find instructions on the website: https://opencode.ai/download
3. Launch 9Router - run 9router in your terminal
4. Visit http://localhost:20128/ in your browser
5. Create Kiro accounts via AWS builder ID
    1. Create a few AWS builder IDs - make accounts at https://aws.amazon.com/builder/
    2. Go back to http://localhost:20128/ and click Providers → Kiro AI → + Add
    3. Connect your first AWS builder ID via the first button
    4. Go to the AWS Builder ID website, log out, and log in with the next account - at https://builder.aws.com/
    5. Repeat steps A-D until you have added all your accounts
6. Turn on the Round-Robin mode for best results


1. Go to Token Saver
2. Enable and configure all these options - the app will do it for you, but Headroom takes a second to boot up so be patient!


1. Create and copy the API token - Endpoint & Key → + Create Key → Copy → Done
2. Create and open ~/.config/opencode/opencode.json in any editor (%USERPROFILE%\.config\opencode\opencode.json on Windows)
3. Paste this inside: 

{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "9router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "9Router",
      "options": {
        "baseURL": "http://localhost:20128/v1",
        "apiKey": "YOUR_API_KEY"
      },
      "models": {
        "kr/claude-sonnet-4.5": {
          "name": "Kiro Claude Sonnet 4.5"
        },
        "kr/claude-sonnet-4.5-thinking": {
          "name": "Kiro Claude Sonnet 4.5 (Thinking)"
        }
      }
    }
  },
  "model": "9router/kr/claude-sonnet-4.5-thinking",
}

1. Replace YOUR_API_KEY with the API key you got earlier
2. Go to the folder where you want to work, then run opencode
3. Enjoy! :ultrafastparrot: 
4. PS: use firefox relay for making accounts!

apart from above guide, launch a subagent to see if we can obtain any good coding/agentic models from free tiers, perferably always free but free credits is ok. 
i would like the following models for free, rate limits are expected, and apart from these, other good coding models too """Rank

Model

Net Improvement


Confirmed Success


Praise vs Complaint


Steerability


Bash Recovery


Tool Hallucination


Sessions

1
1
4
Claude Fable 5 (High)
Anthropic · Proprietary
12.72%
±2.00%
10.67%
±3.84%
23.94%
±7.42%
14.62%
±3.80%
12.97%
±1.30%
1.39%
±0.17%
23,549
2
1
8
GPT 5.6 Sol (xHigh)
OpenAI · Proprietary
10.12%
±1.69%
7.25%
±3.29%
23.53%
±6.57%
9.71%
±2.78%
8.74%
±1.30%
1.39%
±0.17%
15,991
3
1
9
Claude Opus 4.8 (Thinking)
Anthropic · Proprietary
9.75%
±1.39%
8.90%
±2.62%
19.42%
±5.05%
9.78%
±2.58%
10.43%
±1.07%
0.22%
±1.11%
34,147
4
1
9
Kimi K3
Moonshot · Proprietary
9.71%
±1.52%
14.00%
±2.92%
20.30%
±5.45%
6.52%
±3.14%
6.33%
±1.27%
1.39%
±0.17%
11,490
5
2
12
Claude Sonnet 5 (High)
Anthropic · Proprietary
8.66%
±1.89%
8.14%
±3.67%
16.88%
±7.14%
6.20%
±3.66%
10.81%
±0.90%
1.25%
±0.18%
24,359
6
2
10
GPT 5.5 (xHigh)
OpenAI · Proprietary
8.41%
±0.87%
6.65%
±1.78%
11.08%
±3.13%
8.18%
±1.65%
14.77%
±0.80%
1.39%
±0.17%
40,667
7
2
12
Claude Opus 4.7 (Thinking)
Anthropic · Proprietary
7.94%
±1.24%
5.67%
±2.55%
11.55%
±4.36%
8.62%
±2.36%
12.57%
±1.13%
1.28%
±0.19%
35,151
8
2
12
Claude Opus 4.7
Anthropic · Proprietary
7.67%
±1.25%
4.97%
±2.57%
12.48%
±4.38%
8.95%
±2.32%
10.62%
±1.53%
1.33%
±0.17%
35,672
9
3
12
GPT 5.5 (High)
OpenAI · Proprietary
7.61%
±0.81%
6.20%
±1.59%
9.80%
±2.89%
8.77%
±1.44%
11.90%
±1.07%
1.39%
±0.17%
65,859
10
6
14
GLM 5.2 (Max)
Z.ai · MIT · SiliconFlow
6.50%
±1.00%
8.65%
±1.97%
12.94%
±3.63%
4.71%
±1.79%
4.78%
±1.15%
1.39%
±0.17%
38,221
11
5
15
Claude Opus 4.6
Anthropic · Proprietary
6.42%
±1.24%
3.12%
±2.63%
9.94%
±4.21%
6.53%
±2.28%
11.14%
±1.35%
1.39%
±0.17%
34,862
12
10
15
GPT 5.5
OpenAI · Proprietary
5.65%
±0.76%
3.92%
±1.58%
5.67%
±2.65%
6.08%
±1.39%
11.22%
±0.90%
1.39%
±0.17%
66,796
13
10
15
GPT 5.4 (High)
OpenAI · Proprietary
5.64%
±0.77%
6.23%
±1.59%
3.13%
±2.70%
7.75%
±1.46%
9.72%
±0.90%
1.39%
±0.17%
66,142
14
6
15
Grok 4.5
SpaceXAI · Proprietary
5.56%
±1.33%
3.86%
±2.88%
8.17%
±4.91%
3.80%
±2.34%
10.56%
±1.14%
1.39%
±0.17%
21,424
15
11
17
Claude Opus 4.8
Anthropic · Proprietary
3.56%
±1.65%
7.10%
±2.73%
11.63%
±4.80%
8.25%
±2.62%
9.82%
±1.40%
18.98%
±4.59%
32,216
16
15
17
Claude Sonnet 4.6
Anthropic · Proprietary
2.84%
±1.15%
0.62%
±2.62%
0.65%
±3.77%
1.35%
±2.18%
11.45%
±1.47%
1.35%
±0.17%
35,646
17
15
20
GLM 5.1
Z.ai · MIT · SiliconFlow
1.43%
±0.78%
1.12%
±1.74%
0.99%
±2.69%
0.15%
±1.53%
3.79%
±0.89%
1.39%
±0.17%
57,532
18
17
24
Muse Spark 1.1
Meta · Proprietary
0.67%
±0.89%
4.39%
±2.03%
4.30%
±2.73%
4.50%
±1.70%
6.40%
±1.64%
1.36%
±0.17%
28,128
19
17
26
Qwen3.7 Max
Alibaba · Proprietary
0.09%
±1.07%
1.84%
±2.60%
5.73%
±3.50%
0.02%
±2.01%
7.20%
±1.42%
0.83%
±0.29%
15,992
20
18
26
Gemini 3.1 Pro Preview
Google · Proprietary
0.47%
±0.68%
2.05%
±1.49%
0.56%
±2.22%
1.99%
±1.22%
8.29%
±1.11%
1.32%
±0.18%
67,658
21
18
26
Qwen3.7 Plus
Alibaba · Proprietary
0.76%
±1.25%
1.74%
±3.08%
6.50%
±3.88%
1.41%
±2.55%
5.58%
±1.85%
0.30%
±0.51%
12,816
22
17
29
Kimi K2.7 Code
Moonshot · Modified MIT
1.02%
±1.69%
3.79%
±3.49%
0.95%
±6.00%
8.37%
±3.29%
2.86%
±2.78%
1.39%
±0.17%
10,082
23
19
26
Gemini 3.5 Flash (High)
Google · Proprietary
1.03%
±0.80%
2.89%
±1.77%
3.95%
±2.48%
0.68%
±1.46%
1.92%
±1.55%
1.48%
±0.39%
45,992
24
18
27
DeepSeek V4 Pro
DeepSeek · MIT
1.19%
±1.06%
4.80%
±2.70%
5.65%
±3.42%
2.11%
±2.05%
5.76%
±1.02%
0.87%
±0.26%
16,514
25
18
29
Hy3
Tencent · Apache 2.0
2.23%
±2.87%
4.65%
±6.11%
2.87%
±9.99%
7.10%
±5.95%
2.56%
±3.98%
0.89%
±0.82%
3,530
26
19
29
Kimi K2.6
Moonshot · Modified MIT
2.57%
±1.75%
1.67%
±3.51%
3.04%
±5.45%
6.72%
±3.26%
6.17%
±3.87%
1.39%
±0.17%
10,139
27
23
29
Minimax M3
MiniMax · MiniMax Community License
3.10%
±1.05%
7.49%
±2.73%
9.67%
±3.33%
5.43%
±2.14%
6.15%
±0.95%
0.93%
±0.38%
16,030
28
24
29
Mimo V2.5 Pro
Xiaomi · MIT
3.39%
±1.11%
5.88%
±2.73%
10.33%
±3.35%
2.94%
±2.14%
1.69%
±1.91%
0.49%
±0.34%
16,479
29
24
29
DeepSeek V4 Flash
DeepSeek · MIT
3.49%
±1.06%
6.55%
±2.78%
9.75%
±3.31%
4.16%
±2.06%
3.46%
±1.15%
0.46%
±0.40%
16,015
30
30
33
Inkling
Thinky · Apache 2.0
6.41%
±1.31%
7.19%
±3.50%
19.01%
±3.70%
11.60%
±3.00%
6.12%
±1.58%
0.40%
±0.49%
10,678
31
30
34
Gemini 3.5 Flash (Medium)
Google · Proprietary
6.80%
±1.69%
13.18%
±4.10%
8.24%
±4.98%
10.20%
±3.24%
3.28%
±3.38%
0.91%
±0.52%
8,641
32
30
34
Grok Build 0.1
SpaceXAI · Proprietary
8.01%
±0.81%
4.60%
±1.76%
11.93%
±2.39%
12.26%
±1.58%
12.02%
±1.80%
0.78%
±0.17%
59,109
33
30
34
Grok 4.3 (High)
SpaceXAI · Proprietary
8.25%
±0.81%
8.72%
±1.72%
14.91%
±2.00%
7.31%
±1.31%
11.37%
±2.42%
1.08%
±0.18%
47,866
34
31
34
Gemini 3 Flash
Google · Proprietary
8.65%
±0.76%
8.74%
±1.58%
12.32%
±1.90%
5.33%
±1.22%
16.88%
±2.00%
0.03%
±1.18%
68,372
35
35
37
Minimax M2.7
MiniMax · Modified MIT
12.47%
±1.34%
17.13%
±3.13%
15.66%
±3.70%
17.46%
±2.45%
13.35%
±3.31%
1.23%
±0.20%
16,212
36
35
38
Nemotron 3 Ultra
Nvidia · OpenMDW-1.1
13.50%
±2.38%
15.08%
±5.11%
12.20%
±7.28%
21.37%
±4.80%
18.77%
±5.33%
0.09%
±0.67%
10,263
37
35
38
Gemma 4 31B
Google · Apache 2.0
14.51%
±1.60%
2.31%
±1.74%
4.49%
±2.62%
6.87%
±1.53%
33.53%
±5.14%
25.33%
±5.11%
54,817
38
36
38
Grok 4.3
SpaceXAI · Proprietary
15.04%
±1.03%
10.92%
±1.61%
16.20%
±1.85%
7.79%
±1.23%
41.51%
±4.26%
1.21%
±0.18%
67,800"""
found this but you find more too, use subagent
| Provider              | Best For                                                                           | Free Structure                                                     |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Google AI Studio**  | Gemini 3.5 Flash, Gemini 3 Flash, Gemini 3.1 Pro Preview, Gemma 4                  | 5–15 RPM, 100–1,500 RPD, **no CC required**                        |
| **OpenRouter**        | DeepSeek V4, Hy3, MiniMax M3, MiMo V2.5, Nemotron 3, GLM, Qwen, Kimi K2.x, Inkling | 20 RPM, 50–1,000/day, **no CC required**                           |
| **NVIDIA NIM**        | DeepSeek V4 Pro, Nemotron 3 Ultra, MiniMax M2.7, Kimi K2.5, Qwen                   | ~40 RPM free prototyping tier, **no CC**                           |
| **Z.ai (Zhipu AI)**   | GLM 5.1, GLM 5.2                                                                   | Native free tier for GLM family, **no CC**                         |
| **Alibaba DashScope** | Qwen3.7 Max, Qwen3.7 Plus                                                          | 1M free tokens/month, **no CC**                                    |
| **DeepSeek Direct**   | DeepSeek V4 Pro, V4 Flash                                                          | 5M free tokens (30 days), **no CC**                                |
| **xAI API**           | Grok 4.5, Grok 4.3, Grok Build 0.1                                                 | **\$25 sign-up + \$150/month** via data-sharing program, **no CC** |

another freind gave me this
**Base URL:** `http://netic.hackclub.app/v1`

**API Key:** `oc-d1e2065b29c4bb7e839d0bfabcd23410aa59b45a`

   **Models:**
- `big-pickle`
- `deepseek-v4-flash-free`
- `mimo-v2.5-free`
- `ling-3.0-flash-free`
- `nemotron-3-ultra-free`
- `north-mini-code-free`
- `laguna-s-2.1-free`
also use a subagent to figure out how my freind is getting all these models for free, without rate limits, reasearch i did points to opencode zen which is the free plan but that has rate limits and he said this does not. 
it should have no limits more or less and work unlimited
and instead of gemini 3.1 flash lite, try gemini 3.5 flash lite(or 3.6, only one of then has flash lite) these flash lite has limit of 15 per min, so go slow. but unlikey to hit 500 per day limit. 

add ask question tool to kyto same way you have? diff types, etc? and should it be ephemeral? maybe kyto can ask multiple people not just one, but who it not ask, they cant answer. 

Permision system:
when user asks kyto to do stuff that it cant, it posts a msg visible to all, pinging me, asking for approval, and agent will continue, being told that its waiting for approval, and the approvl msg not timeout. this applies to posting in other channels, channel pings, github stuff, etc(but no approval for posting as me, no one can do that)

AGENTS.md seems outdated, same for DEVLOPMENT.md both say Pi

i saw (Completed scheduled actions with no additional message.) in my dm from kyto, what i want is it shows a msg from me mentiong kyto telling it to checkup, etc and says that this is automated so it should not ask questions just leave a report and act on stuff if needed. user token stuff i dont think would alert the app, but since its sent from app, it should still respond. and why did it say no additoanl 

Failed to mention me properly, and started spouting reasoning in main output?
devansh  [9:02 PM]
@kyto go thorough this and gimme your opinions on K3
PDF k3_tech_report.pdfPDFkyto  [9:02 PM]
devansh  [9:04 PM]
actually clone https://github.com/MoonshotAI/Kimi-K3/tree/main and look at readme and tech report may be easier
kyto  [9:04 PM]
kyto  [9:08 PM]
So, overall batch → partial rollouts pause when λNK complete, preserving sanity. That is a production-grade RL trick. Then effort conditioning. Then GRM. Then MOPD. Missing pages but enough.

For infrastructure, I need more. KDA Context Parallelism, MoonEP, memory efficient training, multimodal encoder optimization, 1M agentic RL infra, sandbox infra, inference prefix cache. The key ideas are:
KDA has fixed-size recurrent state S (dk x dv), cheap to transfer across devices. So context parallelism segments sequence, each segment computes its own state and passes a small state to next, unlike full KV cache transfer. This is a huge advantage for KDA over standard attention at very long contexts.
MoonEP: perfectly balanced expert-parallel MoE training. Static computation shapes, zero-copy, deterministic routing. Uses a linear assignment problem (possibly Hungarian-like) to balance tokens across experts. General upper bound proof. Claims no token dropping or padding waste.
Memory efficient training: activation checkpointing, low-precision (MXFP4/8), sequence parallelism maybe.
Multimodal encoder optimization: image/video token reduction, pixel shuffle.
1M agentic RL infra: partial rollouts, external KV-cache retention (since KDA state is small, can store and resume), adaptive throttling, resumable microVM sandboxes.
Inference: KDA-aware prefix cache. Because state is compact, can cache and transfer. Cache-aware affinity scheduling. Budget-based admission control.
kyto  [9:09 PM]
Need to provide opinions. Should mention both strengths and weaknesses. What are opinions? As Kyto, I can be candid but measured. Devansh is my owner. He wants my opinions. So I should be honest and technically grounded. I can mention:
KDA as sequence mixer is elegant and the lower-bounded decay parameterization is a smart numerical fix that lets them use Tensor Cores fully. This matters a lot for throughput.
Hybrid attention 3:1 KDA:MLA is pragmatic: KDA for cheap long-context, MLA for occasional global attention. No positional embeddings needed, direct 1M extrapolation.
Attention residuals: interesting idea to let layers attend to earlier layers; block residuals reduce overhead. Strong empirical support? They cite previous work; here they adopt N=8.
Stable LatentMoE: extreme sparsity 16/896 = 1.8% activated, but total activated params 104B. SiTU-GLU and RMSNorm stabilize. Quantile Balancing is novel auxiliary-loss-free balancing using margins. Good for training at 2.8T scale.
Native vision from scratch: interesting finding that SigLIP init doesn't help at scale and can destabilize. MoonViT-V2 401M params. Pixel shuffle reduces tokens. Shared params for image/video.
Per-head Muon: plausible but I wonder if it generalizes.
Pre-training: 2.5x scaling efficiency over K2. Cosine > WSD after fair hyperparam search. They emphasize "fair comparison" which is a subtle dig at DeepSeek maybe.
Post-training: 3-stage SFT -> RL domain experts -> MOPD. Budget control for reasoning effort. Agentic GRM. Partial rollouts for long-horizon RL. Multi-teacher on-policy distillation to unify. Reasonable and likely required for such a general model.
Infrastructure is a huge part; the report gives details. KDA context parallelism and state-aware prefix caching are legit advantages. MoonEP balanced assignment is clever.
Evaluations: strong open frontier, but still behind Fable 5 and GPT-5.6 Sol. Gaps especially in research-level reasoning (HLE-Full, CritPt), some agentic Elo-rated tasks (GDPval, AA-Briefcase), computer use (OSWorld 2.0, SaaS-Bench). Coding is competitive, best on ProgramBench and SWE-Marathon. Cost efficiency is a win.
Red team / cyber: Tier 1 real bugs, 16 previously unknown, including Linux kernel heap OOB and Dirty-COW-class RDMA bug. Tier 2 end-to-end exploits still hard; 0 of 41 arbitrary code execution. This is a responsible disclosure but also shows misuse risk is bounded for now.
devansh  [9:09 PM]
@kyto explain in simple terms what kimi k3 is good at and what it did
kyto  [9:09 PM]
What are my honest critiques?
The architecture is complex: combining KDA, MLA, Attention Residuals, MoE, native vision. More moving parts = harder to reproduce, more failure modes. But they open-sourced weights, so reproducibility of training details less critical for users.
KDA is a linear recurrence; it may struggle with tasks requiring precise positional/indexed retrieval? They use MLA interleaved and attention residuals, so maybe okay. But 3:1 ratio means most layers use linear attention. Long-context needle-in-haystack performance? They mention synthesized long-context data to prevent local degeneration. I would want to see more public long-context retrieval benchmarks; their suite includes AA-LCR but not much else.
The report claims native vision "no post-hoc modality-alignment stage", but MoonViT-V2 has a projector. That's still alignment. The language is a bit marketing.
Quantile Balancing: interesting but I want to see sensitivity to bin width and ablations. They have appendix derivation.
Per-head Muon and SiTU-GLU: small details that may matter less; hard to judge without ablations in report.
Reasoning-effort RL: budget control via reward penalty might suppress reasoning but also could hurt on genuinely hard tasks. They mitigate with max budget cap. Seems okay.
RL reward hacking: they mention verbosity control, but agentic GRM is still a judge model, can inherit judge biases.
Open weights at 2.8T: huge but inference cost is massive. They tout cost efficiency but only relative to other frontiers; absolute cost per task still high. Need many H100s or specialized infra.
License: Kimi K3 License, likely restrictive (commercial use limits?). Not discussed in detail. Important for "open" claims.
Environmental cost: 3T model training; not mentioned. Could be a concern.
Dependencies on custom infrastructure: FlashKDA, MoonEP, WarpDecode-style kernels, etc. To actually run efficiently users need their stack or reproduce kernels. They open-source model weights but not all infra code. This is a common gap.
Data details: very high-level; exact sources, sizes, filtering not disclosed. Hard to reproduce or assess contamination.
kyto  [9:09 PM]
Maybe also mention: the report's self-awareness is notable: they explicitly say they trail strongest proprietary models. This is refreshing vs some benchmark cherry-picking. But they also note Fable 5 fallbacks and GPT-5.6 cyberguards, which contextually explain some gaps.

Could mention the UK AISI/NIST joint assessment citation: external validation of cyber eval is good.
kyto  [9:09 PM]
kyto  [9:09 PM]
@devansh (U085KKYFA6Q):

what it is
Kimi K3 is a 2.8 trillion parameter sparse model that only activates 104 billion of those parameters per token using a mixture-of-experts design. MoonshotAI released the weights openly today. It handles text, images, and video natively, and it can process up to 1 million tokens in context.kyto  [9:09 PM]
what it’s genuinely good at
long context, cheaply. The headline trick is “Kimi Delta Attention.” Unlike standard attention, which has to pass huge key-value caches around for long sequences, K3 carries a tiny, fixed-size recurrent state. That makes 1-million-token context realistic at inference time instead of a party trick.
efficiency. They claim ~2.5x better scaling efficiency than their last model, K2. With only ~1.8% of the experts actually firing per token, it gets frontier-level performance without every forward pass lighting money on fire.
coding and software engineering. It scores best among open models on things like SWE-Marathon and ProgramBench, and it’s competitive with GPT-5.5/Gemini 2.7 on coding leaderboards.
being an agent. They trained it to actually do things: browse, use computers, write code, run shell commands, and execute long multi-step workflows. It scores well on agentic benchmarks like OSWorld and AA-Briefcase.
vision. It was trained on images and video from scratch rather than bolted on later. They ditched SigLIP initialization and built their own MoonViT-V2 vision encoder.
responsible disclosure posture. Their red-team found 16 previously unknown real-world bugs, including Linux kernel issues, and disclosed them.
kyto  [9:10 PM]
what it actually did / achieved
Released the weights and this 47-page report explaining the architecture, training recipe, and infrastructure.
Hit or nears state-of-the-art among openly released models across reasoning, coding, math, agents, and vision.
Published a new version of their internal coding benchmark, Kimi Code Bench 2.0.
Showed a training recipe that does large-scale supervised fine-tuning first, then domain-specific reinforcement learning, then distills everything into a single deployment model.
Built custom infrastructure to make this practical: a balanced expert-parallel training system called MoonEP, context parallelism optimized for their delta-attention state, microVM sandboxes for agentic RL, and inference caching tricks for that compact state.
Got an external joint cyber-security evaluation from UK AISI and NIST, which is unusual and adds credibility.
kyto  [9:10 PM]
the honest picture
It is not the absolute best model in the world. OpenAI’s GPT-5.6 Sol and xAI’s Fable 5 still lead on several hard reasoning and agentic tasks. But K3 looks like one of the strongest openly available frontier models announced so far, and the efficiency / long-context angle is the real differentiator, not just benchmark bragging.kyto  [9:10 PM]
756 tokens · 17 tok/s

Same issue here, not a proper mentinon 
@gork2 (U09NCF07DP1)

when it askes for perms to send msg and i accept it sends accept message(ephemeral) in dm/channel and the thread too(dm if i asked in dm, otherwise channel i asked)

cant see DMs i shared with it
devansh  [10:09 PM]
@kyto I want to be a promethean. here is what @eps told me https://hackclub.slack.com/archives/D0BDJAHKTTQ/p1785169769994439 so find channels where its needed
Generally people just asked! I said yes to requests where (1) The channel is an important part of the Slack, (2) The person has a good vision for how to improve it, and (3) I know them, or they are recommended to me by someone I know
Direct message | Today at 9:59 PM | View conversationkyto  [10:09 PM]
Thinkingmoonshotai/kimi-k2.7-code
ThinkingThe user is Devansh (the bot owner). He references a message from @eps and wants me to find channels where it's needed. I need to read the linked Slack message first. The link is:
workspace: hackclub.slack.com
channel ID: D0BDJAHKHTTQ
timestamp: p1785169769994439 -> message ts: 1785169769.994439


I need to use readConversationHistory on that channel/thread. Since it's a DM (D... channel), I might not have access unless this is a DM I'm in or the owner has authorized. But I should try to read it. The user is sharing a direct message link. Since it's a DM, I (the bot) can read conversations the user is in? Actually, Slack bot can't read DMs it's not a member of. But devansh is sharing the link; perhaps the bot can access it since the owner gave permission? The tool says "the current conversation is always readable; other channels must be public". DMs are not public. So I likely cannot read that DM unless the bot was added to it. But maybe I can fetch via the message link? No. I should attempt using readConversationHistory with the channelId and threadId. If it fails, I'll inform the user.

But I might also search Slack for context, e.g., query for "promethean" or "prometheans" in Hack Club. That would be helpful. The term "promethean" likely refers to a Hack Club initiative like "Promethean Awards" or maybe a hackathon role. I should search the workspace for the message content or relevant channels.

The user says: "I want to be a promethean. here is what @eps told me [link] so find channels where its needed". So he wants me to find channels where prometheans are needed. I should read the linked message, and then search relevant channels.

I must work in a single turn. I can attempt to read the DM. If can't, I'll ask devansh for the content. But likely I cannot read it because DMs require bot membership. However, maybe I can read because the owner is invoking and the tool says current conversation always readable; this linked DM is not current conversation. Hmm.

I could also ask @eps? But better to just attempt and then if blocked, ask Devansh to paste contents.

But the instructions say "when the task needs multiple steps ... MUST carry it all the way to completion in THIS turn." However if I'm blocked by inability to read private DM, I might need to ask. Let's try reading it and also searching Slack.

Since the instruction says run Slack searches early, I should do that. The search query can be about "promethean" and "eps". I can also try to read the message. I can also list public channels maybe. But I should use searchSlack.

Let's call readConversationHistory on D0BDJAHKTTQ with thread ts 1785169769.994439? Actually the link is a thread? p format. The timestamp is 1785169769.994439. If it was a top-level message, readConversationHistory wi…
Reading historyD0BDJAHKTTQ
Error: An API error occurred: channel_not_found
Searching Slackpromethean
Found 10 Slack results for "promethean".
ThinkingI can't read the DM. I got search results for "promethean". The linked message from @eps (Evan Streams) is in channel C0ASZ9ZSV4 "prometheans" with the standard instructions. But the user shared a DM link; I can't read it. I should tell Devansh that I can't access the DM, but I can infer from the public channel.
is using reading history correct for this?

stoped in middle
devansh  [10:13 PM]
heres the list of current stewards, i want to be for a new channel, not to a current channel https://hackclub.enterprise.slack.com/docs/T0266FRGM/F0ASZA0A14G
 | Canvas Channel Stewards
CanvasChannel
Stewards
#confessions 
@hna, @alice , @reindeer
#ysws #ysws-drafts︇ #ysws-bulletin 
@Rohan , @sahil , @cookie with coffee ( /home/cloudglides )  @Anson Chung @Rushmore 
#lounge 
@Raqeeb 
#help 
@coolcream , @stellenium 
kyto  [10:13 PM]
Thinkingmoonshotai/kimi-k2.7-code
ThinkingDevansh is telling me: he wants to be a promethean for a NEW channel, not an existing channel with a current steward. He shared a list of current stewards (file F0ASZA0A14G). I need to read this file.

I need to fetch the file. Let me call getFile on it.
Downloading fileF0ASZA0A14G
Downloaded Channel_Stewards.
ThinkingThe file is a Slack doc (canvas). I need to read it. Let me try readFile first.
readFilereadFile: /home/user/downloads/Channel_Stewards
Completed.
ThinkingThe file is truncated. I need to read the rest. Let me use readFile with startLine or use bash to parse it more cleanly. Since it's HTML, I could use python to extract the channel IDs.

Actually, I should parse this properly. Let me write a small script to extract channel IDs and list them. But I may also need to know which channels already have stewards. The list shows channels that have stewards. So a "new channel" would be one not on this list.

But I need the complete list. Let me read the rest of the file.
Running commandpython3 - <<'PY' ; import re ; with open('/home/user/downloads/Channel_Stewards','r') as f:
Completed.
ThinkingGood, I got the list of channels with stewards. Now I need to find channels that don't have stewards but might need them. Actually, a "new channel" could mean:
A brand new channel he wants to create
An existing channel that's currently unmanaged (no steward)
A niche/idea that hasn't been turned into a channel yet


I need to look at the file content more carefully to see the names of these stewarded channels. Let me parse it with channel names too.

Actually the HTML has only IDs without names. I need to look up these channels. But more importantly, I need to identify important channels without stewards.

Approach:
Get the list of current stewarded channels.
Search for recent discussions about new channels or channels needing stewards.
Cross-reference to find important channels without stewards.
Also consider channels where a known community hub exists but no steward.


Let me first resolve channel IDs to names for the stewarded list, so I can give Devansh a clean picture. Use slack API or search.

Actually, since I have channel IDs, I can use the Slack API (via slack CLI in sandbox) or use conversation.info. Or I can list them in a script. But I need to find channels WITHOUT stewards.

I could also do a public channel listing sorted by member count / activity, then cross-reference. But not all channels need prometheans.

Let me search for recent discussions about new channels, channels needing prometheans, or the current state. Search in #prometheans, #meta, etc.

I should search Slack now while token is fresh. Use searchSlack for:
"new channel" in #prometheans
"needs a steward"
"no steward"
"channel idea"
"create a channel"
etc.
also maybe list public channels via conversations.list


Wait, I can use the Slack API in sandbox to list channels. slack conversations.list might work. But I can't post, only read. Let me use it.

Actually, I should run a script via bash to:
get conversations.list
filter out channels that are archived
map stewarded IDs to names
identify big/active channels without stewards


Let me write a script. Use slack CLI inside sandbox.
Running commandpython3 - <<'PY' ; import re, json, os, urllib.request ; from urllib.error import HTTPError
Completed.
ThinkingNow let me find channel names and identify candidates. Use slack CLI to get conversations.list and channel info.
Running commandslack conversations.list --limit 200 --exclude_archived true --types public_channel
Completed.
ThinkingSlack CLI usage might be wrong. Let me try slack api conversations.list or check format.
Running commandslack --help
Completed.
ThinkingThe Slack CLI expects JSON arguments. Let me try slack conversations.list {} or similar.
Running commandslack conversations.list '{}'
Completed.
ThinkingIt says invalid_json_body. Maybe the format is slack method arg1 arg2 but JSON body not accepted properly. Or the slack command expects keys on stdin? Let me try different invocation.
Running commandecho '{}' | slack conversations.list
Completed.
ThinkingIt worked with stdin. Let me write a script that:
Runs conversations.list with pagination
Filters unarchived channels
Marks which have stewards
Sorts by member count
Outputs top candidates


I need to handle pagination. Let me do this in codeMode or bash. codeMode may be cleaner. But I can also use bash with Python and the slack CLI.

Important: slack command reads JSON args from stdin. So I can run echo '{"limit":200,"cursor":"..."}' | slack conversations.list.

Let me write a Python script.
Running commandcat <<'PY' > /tmp/list_channels.py ; import subprocess, json, sys ; def slack_call(method, body…
Completed.
ThinkingThe listing is running in background. Meanwhile, I can search Slack for channels that need prometheans or new channels. Let me do searches in parallel to be fast, but the tool token might expire. Let me use searchSlack now.
Searching Slackpromethean new channel OR new channel idea OR needs a steward has:thread
Error: An API error occurred: invalid_action_token
Searching Slackchannel without steward OR no steward OR looking for channel managers
Error: An API error occurred: invalid_action_token
Searching Slackprometheans in:#meta OR in:#prometheans after:2026-07-20
Error: An API error occurred: invalid_action_token
ThinkingSlack search token expired (we're >2 min). That's okay, I have enough from earlier. I'll rely on the API listing. Let me poll the background process.
Downloading filebg-7
Error: Could not resolve a download URL for: bg-7
ThinkingI used wrong tool. Should use getProcessOutput.
Running commandgetProcessOutput bg-7
Completed.
ThinkingI need to load runBackgroundProcess/getProcessOutput tools. Wait, I can just read the output file because the script writes to /tmp/channels_report.txt. Let me check.
Downloading file/tmp/channels_report.txt
Error: Could not resolve a download URL for: /tmp/channels_report.txt
ThinkinggetFile is for Slack files. I should use bash to check the process.
Running commandps aux | grep list_channels
Completed.
ThinkingThe background process is still running (python3 /tmp/list_channels.py). I need to wait for it. But I also want to avoid long wait. I can check output file directly.
Running commandcat /tmp/channels_report.txt
Completed.
ThinkingThe output keeps growing. It seems to have many channels. The cursor might be looping? Wait, same cursor every time? That's suspicious. Actually dGVhbTpDMjJCS0Y1NDc= appears repeatedly, which is weird. But the count grows each request by 100. Maybe the metadata is duplicating but actual results are advancing? Or maybe the script is not updating cursor correctly? Wait, cursor is set from response_metadata.next_cursor. If cursor never changes, the API would return the same 100 every time. That would be a bug. But count grows? Actually print says "got 100", "got 200", etc. If same cursor, it would still append same channels each time. Count would still increase because same 100 appended each time. That's clearly happening. I should stop this.

Also pagination for enterprise grid might use different cursor handling. Let me kill it.
Running commandpkill -f list_channels.py && sleep 0.5 && ps aux | grep list_channels
kyto  [10:19 PM]
Running commandCompleted.
Thinkingpkill still running? OK I'll load getProcessOutput/killProcess tools.
loadToolsCompleted.ThinkingThinkingkyto  [10:19 PM]
2,569 tokens · 7.5 tok/s
thread id is https://hackclub.slack.com/archives/D0BCCM9GL68/p1785170357735709

WHAT? NO TOOLS? why
Lily  ̂ - ̂  (KitKat)  [5:30 PM]
@kyto @gorkie @Borkie try translating this sitelen pona into normal sitelen lasina then english https://hackclub.enterprise.slack.com/files/U0B2VTYER33/F0BL8NEA6TY/screenshot_2026-07-28_at_5.51.13___pm.png
Screenshot 2026-07-28 at 5.51.13 PM.png kyto  [5:30 PM]
kyto  [5:30 PM]
I'll grab the image and translate it.
Lily  ̂ - ̂  (KitKat)  [5:30 PM]
## no more additional prompting @devansh
kyto  [5:30 PM]
devansh  [5:31 PM]
## oki
Borkie  [5:34 PM]
kyto  [5:36 PM]
ThinkingThis is helpful! From the lookup chart:


1 element, 1 loop: "ijo, kala, mi, nimi, ona, sina, palisa"
"sina" has 1 element, 1 loop!
"ona" has 1 element, 1 loop
"mi" has 1 element, 1 loop
"ijo" = thing, "kala" = fish, "nimi" = word, "palisa" = pole



So the b/6 shape with one loop and one connected element could be sina, ona, mi, or others.

But I know from visual:
"mi" is usually just a dot/small circle
"ona" is a circle with a line
"sina" is a person shape that can look like a backwards "b" or the number "6" in some fonts


Given the user is testing us with an image, sina seems most likely for that glyph.

Now the other glyphs:
Two hearts = "olin" (listed under 4 disconnected elements, 1+ loops: "moku, mu, oko, olin, toki" — and indeed two hearts are olin)
>> = "tawa" (4 connected elements, 0 loops: awen, kama, nanpa, sijelo, tawa, utala; ">>" looks like tawa)
X with downward spikes = "weka" (4 disconnected elements, 0 loops: anpa, ante, e, epiku, insa, kin, monsi, poka, seli, sewi1, sewi, sinpin, weka; weka is drawn as legs walking away, looks like X with feet)
T = "li"? The chart puts "li" as 2 connected elements, 0 loops (one vertical + one horizontal stroke crossing it). Yes T = li.
Square with 3 lines above = "seli" (also in the same 4 disconnected elements category as weka; seli is fire, drawn as flames above a base)
Plain X = could be "mute" (3 disconnected elements, 0 loops: kipisi, meso, mute, powe, sin; mute is drawn as crossed lines, X shape)
= single arrow = could be "kama" or "tawa"? Kama is in 4 connected, 0 loops, drawn as an arrow pointing right. Tawa is drawn as >> (double arrow). So > = kama (come/arrive/approach).
Frown = "ike" (1 element, 0 loops: ike is a sad face/frown)


Now putting it together:
Row 1: sina olin tawa weka
Row 2: li sina seli mute
Row 3: weka kama ike tawa sina

Wait, this still doesn't parse. Let me reconsider.

Actually, maybe Row 2 symbol 2 is not "sina" but something else. Looking at the chart, "seli" is in the same category, but the square with three lines is clearly seli.

But what about the b/6 shape? If it's "palisa" (pole/branch/bar)? Then "palisa" is a straight vertical line usually, not b-shaped.

"ijo" is a thing, drawn as a simple circle or outline. Not b.

"kala" is a fish. Not b.

"nimi" is a word/name, drawn like a speech bubble or simple shape.

Wait, "sina" in many fonts is the stick figure, and one-loop fits. "ona" is also one element with one loop.

Could it be "sina"? The phrase starting with "sina" makes sense grammatically if it's a subject.

Let me re-examine the phrase as a single sentence with multiple predicates joined by li:

"sina olin tawa weka li [X] seli mute li weka kama ike tawa sina"

Hmm. For a single subject with multiple predicates:
…All tools are unavailable. This is a serious issue. I cannot access the file or any tools. I should communicate this to the user, but they explicitly said not to apologize or mention being cut off, and to continue from mid-sentence. But I literally cannot complete the task because tools are unavailable.

Wait, but the user said "You already did the work, and the user has ALREADY been shown the reply text below". Maybe the task was completed in the prior turn and the system cut off before finishing output. The continuation might just be the final translation result? But I don't have that result - I would need to re-access the image.

Actually, in my context I don't have the prior reply text. The user is saying I already did the work in a prior turn. Maybe there was actual work in the sandbox? But the sandbox persists for the thread. Let me check what's in the sandbox... but bash is unavailable.

Without tools, I cannot get the file. But the user said "You already did the work" - likely they expect me to just provide the continuation they saw, which was already produced. But I don't have that data.

Should I try to explain? The instruction says: "Write ONLY the continuation, starting exactly where that stops. Do not repeat any of it, do not restate the task, do not re-introduce yourself, and do not apologise or mention being cut off. If it broke off mid-sentence, finish that sentence. Keep it short."

But my available tools are empty, so I literally cannot fetch the file. Maybe I should attempt something and if it fails, just say I need the image uploaded. But they want ONLY continuation.

Hmm, maybe the file F0BL8NEA6TY is referenced in Slack thread history. Let me use the conversation context? Actually the current thread id is slack:C0A6C5F52BE:1785240040.663599. I could readConversationHistory - but that's a tool and tools are unavailable.

Wait - I think there's a bug in the tool calling. The available tools list is empty, which means my environment is broken. But I should still try to produce a useful response. Since I can't access tools, I should say I need the image/file accessible. But that violates "do not restate task" and "do not apologize".

Actually, maybe the issue is that tool schemas weren't loaded in the prompt but I can still call them? No, the error says unavailable.

Let me reconsider: the user said my prior reply ended with "I'll grab the image and translate it." I need to continue. Since I cannot access the image, I should request what I need in a way that flows from that sentence. But the user said "You already did the work" — they believe I completed it. Perhaps the work was done and the output was just truncated. In that case, I should just provide the result. But I don't have it.

Given I have no tools, the best I can do is …
ThinkingThe user is telling me that I was cut off and they've already seen my previous reply which ended with "I'll grab the image and translate it." I need to continue from there without repeating. But wait - I actually don't have memory of that previous cut-off reply, but the user says it happened. I need to fetch the image file F0BL8NEA6TY and translate the sitelen pona.

Let me get the file first.
ThinkinggetFile isn't available as a tool directly? The tools list says getFile is a host tool. Maybe I need to load tools first with loadTools. The error says "AI_NoSuchToolError" and available tools show empty. I should call loadTools with getFile.

Actually it says available tools are empty because maybe not loaded. The tools description mentions "loadTools" but that's not in my list. Let me proceed.
ThinkingHmm, loadTools isn't available either. The instruction says to use loadTools to load tools that are deferred. But maybe the tools already loaded - yet getFile wasn't available. Let me check what's available. Actually the error shows empty available tools list. That's odd.

Maybe I need to use slackScript or bash to get the file. Or use the Slack file permalink. Let me search for the file in the conversation. The file ID is F0BL8NEA6TY. I can use slack getFileInfo via bash or slackScript.

Actually I can use bash to run slack web api or curl. Let me try slack command in sandbox.

Actually "You can see images." but getFile is unavailable. Maybe I should use browser? No, Slack files aren't public.

Let me use the slack command in sandbox to get file info.
ThinkingNo tools available? That's strange. It says Available tools: . empty. Maybe I'm in a state where I can't call tools. But I need to. Let me just call a basic tool that should be available. Perhaps tools weren't initialized. Let me try the react tool or something else.