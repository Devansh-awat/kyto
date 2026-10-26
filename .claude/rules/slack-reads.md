---
paths:
  - "apps/bot/src/lib/slack/**"
  - "apps/bot/src/lib/ai/tools/search-slack.ts"
  - "apps/bot/src/lib/ai/tools/read-conversation-history.ts"
---

# Linked canvases and searchSlack

Part of the project notes (`.claude/CLAUDE.md`); loaded when you work on these files. Keep it current in the same change as the feature.

- **Linked canvases are read into the turn** (`lib/slack/linked-canvases.ts`, #76): up to 2 canvases the new message links or attaches, ≤12k chars each, in the prompt tail as untrusted `<linked_canvas>` data — ONLY when it is shared somewhere the asker can read (`mayReadChannel`, fails closed), else a stub says why.
- **`searchSlack`** returns `totalMatches` (Slack's count for the whole query) ONLY on the asker's-own-token path — kyto's account path is filtered after the search, so its total would count channels the asker isn't in. Order: the asker's OWN token (their OAuth grant; owner: `SLACK_USER_TOKEN`) → the per-mention action token (`channel_types` all four) → **kyto's user account, hits kept ONLY from channels the asker is in** (`users.conversations`, fail closed). The action token covers the asker's private channels/DMs (the bot token holds `search:read.private`/`.im`/`.mpim`; a Slack docs page saying public-only is stale), sorts by time for an ordered search and sends `include_bots`. An empty result from kyto's account with no action token says it may not be visible, with the connect link. Never anyone else's token. Cursors are tagged by the way in that issued them.
