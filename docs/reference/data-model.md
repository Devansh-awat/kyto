---
title: Data Model
description: What Postgres stores and why.
---

Everything Kyto persists is defined in `packages/db/src/schema/`, one file per
area, with the queries beside them in `packages/db/src/queries/`. Those files are
the reference for columns and indexes — this page is the map of what exists and
why it is kept, which is the part that is not obvious from a schema.

There is deliberately **no conversation store**. The Slack thread is the memory;
what kyto persists about a conversation is derived text, and it is bounded.

## Conversation State

| Table | Why it exists |
| --- | --- |
| `thread_subscriptions` | Per-thread state: whether kyto is following, focus mode, and small per-thread flags. |
| `thread_thinking` | The last few turns' reasoning per thread. Slack records only what kyto *said*, so without this every turn re-derives the previous turn's conclusions. Kept ~30 days, reaped daily. |
| `thread_summaries` | The compacted digest of the part of a thread that no longer fits in the replay window, with how far it has been folded in. Kept ~30 days. |
| `thread_sandboxes` | Which E2B sandbox belongs to which thread, and when it was last touched — how a paused sandbox is found again next turn, and how the reaper knows what is idle. |
| `sandbox_sessions` | Legacy sandbox lifecycle rows from before per-thread persistence. |

Both `thread_thinking` and `thread_summaries` can paraphrase what people said,
which is why they expire and why a user can erase their own.

## People

| Table | Why it exists |
| --- | --- |
| `user_customizations` | App Home instructions and presets. |
| `memories` | Saved facts. **Private to their author** until the bot owner promotes one, because a global memory is a standing instruction to kyto for everyone. |
| `user_model_credentials` | BYOK provider keys, AES-256-GCM ciphertext only. |
| `user_chatgpt_accounts` | Sign in with ChatGPT: an OAuth'd subscription, ciphertext only, plus when a spent quota resets. |
| `user_slack_grants` | A person's own Slack token, ciphertext only — what lets kyto act as *them* where they have asked it to. |
| `user_mcp_servers` | Per-user remote MCP servers added from App Home. |
| `identity_profiles` | Owner-configured icons per message type. |

No table returns a plaintext secret except through the one query written to
fetch it, and a secret is never logged, prompted, or passed into a sandbox.

## Gates And Permissions

| Table | Why it exists |
| --- | --- |
| `approval_requests` | The persisted approval queue: a non-owner's cross-channel post, a broadcast, a third-party GitHub write. Public buttons, but only the entitled approver's click counts. |
| `github_repos` | Which Slack user a repo is claimed by. Kyto has ONE GitHub identity, so this is what keeps two people's repos apart. |
| `github_trust` | Owner-granted trust for writing outside kyto's namespace. |
| `github_requests` | Third-party write attempts that were queued rather than refused. |

## Things Kyto Made

| Table | Why it exists |
| --- | --- |
| `reminders` | One-off and recurring jobs, including the ones that run a script or a whole agent turn. |
| `sites` | Hosted static sites and who may edit them. |

## Migrations

New tables and columns go in as one-off
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` SQL.
`drizzle-kit push` prompts interactively and hangs in a non-TTY shell.
