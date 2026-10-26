---
paths:
  - "apps/bot/src/lib/code-channels.ts"
  - "apps/bot/src/features/code-channels/**"
  - "apps/bot/src/lib/slack/code-channel-api.ts"
  - "apps/bot/src/lib/ai/tools/code-channel*"
  - "apps/bot/src/harness/**"
---

# Code channels

Part of the project notes (`.claude/CLAUDE.md`); loaded when you work on these files. Keep it current in the same change as the feature.

- **Code channels** (`lib/code-channels.ts`, `codeChannel`, `features/code-channels`): ONE sandbox per channel (`sandboxKey`). **Native** (`native`): a real Slack code channel with kyto's APP as agent (`code_channels:manage`, `features.code_channels`; `agents.*` via `lib/slack/code-channel-api.ts`). Slack's design (owner's call 2026-10-10): the whole channel is ONE conversation — thread id `slack:C…` with no ts (`isChannelConversation` in the harness, sync from a boot-loaded set), every human message answered without a mention, replies streamed top-level (`TopLevelStreamer`), a user-started thread answered in place; status `processing`/`active`, the stop button stops the turn (only the asker's or owner's click), its slash commands and Block Kit tab clicks become that person's message. `create` ONLY when asked: linked to the request (join card, origin privacy) or, from a DM/group DM, private + requester invited; then a handoff turn there. A channel started with kyto from Slack's UI is adopted on its first mention, only if its record names kyto (`kytoIsAgentOf`) — never another agent's. Tabs/canvas (ids kept in `canvas_views`; Slack can't remove a canvas tab)/context bar/commands/rename act only on the turn's own channel; archive ONLY when asked, by enabler/creator/owner. **Ordinary**: a plain channel enabled by its creator or the owner; each top-level message gets its own thread. `LazySandbox` counts holders so the first of two concurrent turns doesn't pause the sandbox under the other.
