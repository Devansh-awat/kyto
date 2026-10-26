---
paths:
  - "apps/bot/src/lib/ai/mcp*.ts"
  - "apps/bot/src/features/mcp-permissions/**"
  - "apps/bot/src/features/customizations/**"
  - "apps/bot/src/lib/public-url.ts"
  - "packages/db/src/**/*mcp*"
  - "packages/db/src/**/*group*"
---

# Per-user MCP servers and channel groups

Part of the project notes (`.claude/CLAUDE.md`); loaded when you work on these files. Keep it current in the same change as the feature.

- **Per-user MCP servers** (`lib/ai/mcp.ts`, App Home), deferred, namespaced `mcp_<server>_<tool>`. Load-bearing:
  - **The URL must be PUBLIC, checked at save AND at connect with a DNS resolve** (`lib/public-url.ts`, which also guards `fetchUrl` and BYOK base URLs) — else `169.254.169.254` or a neighbouring container is readable from Slack.
  - **Shareable with a channel or channel group**; the credential is not copied. The SPEAKER approves an `ask`; a STANDING rule stays with the credential's owner.
  - **Namespaces resolved deterministically** (`resolveTurnMcpServers`): own names win, a colliding share gets `_2`, order stable (else the prompt cache reshuffles).
  - **OAuth sign-in** (`lib/ai/mcp-oauth.ts`, owner's ask 2026-10-13): App Home "Sign in (OAuth)" on the owner's own server → protected-resource metadata → auth-server metadata → dynamic client registration → PKCE link shown ONLY in their modal (encrypted `state`, no public start route) → `/_mcpauth/callback` stores client + tokens as one encrypted blob (`user_mcp_servers.oauth`, needs `BYOK_ENCRYPTION_KEY`). Refreshed 5 min before expiry at turn start (one refresh per server at a time), wins over a pasted token, ignored once the URL is edited; a share runs on the owner's sign-in. Every discovered URL goes through `publicFetch`.
  - Bare token → `Bearer <token>` at save; a failed listing is RECORDED (App Home shows it, doubles as a 60s negative cache); listing cache keyed by URL **and** credential.
  - **Per-tool rules** (`mcp-permissions.ts`): `read`/`sensitive`/`write`/`unknown` × `allow`/`ask`/`never`, per-tool pins; corrupt rules fall back to the SAFE shape. **`never` = not registered.** **`ask` = threaded ephemeral on every call, only the approver may click, no DM fallback**, unattended runs refuse.
  - **Built-ins for everyone** (`mcp-builtin.ts`, appended last so a user's own name wins): **Context7** (two read tools pinned, rest `never`) and **AgentMail on kyto's inbox** — all 38 tools (owner's call; GATING.md has the accepted holes); every RESULT still goes through `lib/email/redact`.
- **Channel groups** (`channel_groups`): a named set of channels sharing MCP servers and promoted memories. Anyone may create one; only its creator (and the owner) may change it, checked at modal OPEN and SUBMIT. A share follows the group (the App Home copy says so). Deleting a group drops its shares and demotes its memories — an orphan would be invisible and unrevocable. Resolved once per turn in `buildTools`.
