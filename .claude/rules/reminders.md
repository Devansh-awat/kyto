---
paths:
  - "apps/bot/src/lib/reminders/**"
  - "apps/bot/src/lib/ai/tools/*reminder*"
---

# Event reminders

Part of the project notes (`.claude/CLAUDE.md`); loaded when you work on these files. Keep it current in the same change as the feature.

- **Event reminders** (`lib/reminders/events.ts`, reminders action `on_event`, owner's ask 2026-10-11): `recurrence: 'event'` + a `trigger` (`slack_message` with optional user/text/regex/thread, `slack_reaction` with optional emoji/user/message/thread and `minReactions` (owner's ask 2026-10-17: once per message when its reactions — of that emoji, else all — reach N), `slack_replies` (once per thread when its replies reach `minReplies`), `webhook` = secret URL `/_hooks/<id>/<secret>`, `github` = `/_hooks/<id>` verified against `X-Hub-Signature-256`); `nextRunAt` sits at 9999 so the time scheduler never takes one. Matched from an in-memory copy (30s refresh). Fires are CLAIMED (`claimEventFire`, conditional on cooldown — 1 min, 5 for bash, 10 for agent — so a burst fires once); a count trigger instead claims its message/thread in `reminder_event_marks` and skips the cooldown, so each fires once, ever. A Slack trigger needs kyto in the channel and the creator able to read it (re-checked each fire); kyto's own posts, `##`, `!secret` and non-opted-in humans never trigger. The event reaches an `agent` job as untrusted `<event>` data; other kinds just say what fired them. A webhook URL/secret is a key: shown only in a DM, otherwise sent to the asker ephemerally (the plan card is public).
- **An agent job's `postMessage` never waits on a confirm click** (`reminderJob` in `buildTools`; owner's call 2026-11-01): nobody is watching, and the ad job once blocked 10 min on an ephemeral button in an old DM thread, then had its "wasn't approved" line posted publicly. A post to the reminder's OWN `channelId` goes straight out when ordinary members can post there (`membersCanPost`, fails closed); any other post that would need the owner's click is refused at once and the job is told to return the message as its final text. A non-owner's cross-channel post still goes to the (persisted, non-blocking) approval queue.
