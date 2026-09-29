---
name: summarize-channel
description: Summarize what happened in a Slack channel or thread into a tight recap with decisions, action items and open questions. Use for "recap #channel", "what happened in this thread", "summary of #design".
---

> Adapted from coolton's `summarize-channel` skill ([itzmetanjim/coolton](https://github.com/itzmetanjim/coolton), AGPL-3.0).

# Summarize a channel or thread

## Steps
1. A named channel: `listThreads` for its recent threads (or `readConversationHistory` for its top-level messages), and pick the ones in the time range asked about.
2. Each thread worth covering: `summarizeThread` (no arguments summarizes the current thread).
3. Answer in this shape:

```
recap of <channel/thread>
*decisions:* …
*action items:* … (with owners when known)
*open questions:* …
```

## Notes
- Under 15 lines. No filler.
- A short conversation gets a one-line answer saying so, not padding.
- Skip empty sections rather than writing "none".
