---
name: compare-ai-models
description: Compare two or more AI models (e.g. Kimi K2.6 vs MiniMax M2.7) and give a use-case-based verdict. Use for "is X or Y better?", "compare model A and B", questions about new LLMs, coding or agentic models. Not for non-model product comparisons or single-model questions.
---

> Adapted from coolton's `compare-ai-models` skill ([itzmetanjim/coolton](https://github.com/itzmetanjim/coolton), AGPL-3.0).

# Compare AI models

## Inputs
- The model names, spelled correctly (people typo them: "mimimax" → MiniMax).
- Ideally the use case: coding, agents, local hosting, general chat.

## Steps
1. **Check each model exists** with `searchWeb` (name + "release" / the vendor). New models are often real and only just out — confirm before calling one fake.
2. **Find the head-to-head**: search "<A> vs <B> benchmark", plus per-model benchmark queries (SWE-bench, agentic, coding). Good sources: artificialanalysis.ai, benchlm.ai, the vendors' Hugging Face / GitHub READMEs. `fetchUrl` the best one or two.
3. **Say what each model is for** — its headline strength, in a line.
4. **Give a verdict by use case**, not one overall winner.
5. **Offer to go deeper** (the benchmark table, one use case) instead of dumping everything.

## Rules
- Never call a model fake without having searched.
- Cite what you found; never invent benchmark numbers.
