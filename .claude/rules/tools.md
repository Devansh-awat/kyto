---
paths:
  - "apps/bot/src/lib/ai/**"
  - "apps/bot/src/lib/skills/**"
  - "apps/bot/src/skills/**"
---

# Tool families, todo, repeat cache, workspace files, skills

Part of the project notes (`.claude/CLAUDE.md`); loaded when you work on these files. Keep it current in the same change as the feature.

- **Tool families** (`lib/ai/merge-tools.ts`): `memory`, `reminders`, `canvas`, `sites`, `process`, `pins`, `reaction`, `followThread`, `embed`, `email`, `subagent` are ONE tool each with an `action` field. The schema is FLAT (OpenAI rejects a top-level union); each action is validated by and runs its ORIGINAL tool, which is `trackUse`-wrapped under its original name first — so usage logs, `CODE_TOOLS`, `SLACK_READ_TOOLS`, `PUBLIC_POSTING_TOOLS` and the plan renderers (`originalToolName`) all still speak the original verbs. A family is core if any verb was. Old loaded/preloaded names map through `FAMILY_OF`.
- **`todo`** (owner's ask 2026-10-16): a live checklist (workspace emoji `checked-t`/`loading`/`unchecked-t` in one rich_text; the plan block collapses), only for LARGE tasks (4+ parts, many minutes), kept at the bottom of the thread (reposted under anything newer mid-turn); deleted when finished, an unfinished one handed to the next turn (TOOLS.md).
- **An identical Slack read or web search** (`SLACK_READ_TOOLS` + `searchWeb`, same input) within 5 min of the turn is answered from the turn's copy, marked `repeated` (owner's call 2026-10-26: a repeat, not a cap); any `EFFECT_TOOLS` call (incl. `wait`) clears the copies; never across turns (#119).
- **`uploadFile`** STREAMS the file from the sandbox to Slack (`session.readFileStream` → Slack's external upload in `ThreadHandle.postFiles`, a fixed `Content-Length`), so a big file never sits whole in the heap: buffered (heap, a `Buffer` copy, the multipart form), one 385 MB pack OOM-killed the 2 GiB pod four times running on 2026-10-27. It stat-checks first (`session.fileSize`, polled while a sibling call writes the file) and refuses over `MAX_UPLOAD_BYTES` (1 GB, Slack's own limit); uploads stay serialized across turns (`uploadChain`).
- **Workspace files** (`tools/workspace-files.ts`, TOOLS.md): `editFile`/an overwriting `writeFile` need a `readFile` of that file THIS TURN and refuse if it changed since; `readFile` is line-numbered; `grep`/`glob` run ripgrep with the model's values only as quoted arguments; `bash` takes `timeout`.
- **Skills** (`lib/skills/`, `skills` table): `loadSkill` (core; the index IS its description, sorted — tool schemas are cached prefix) and `manageSkills` (**owner-only registration**: a skill is prompt text every turn loads). Built-ins = `apps/bot/src/skills/*.md` (a bad one fails boot); owner rows add/override. Install only from GitHub over https (`githubSkillSource`, tested). Unlicensed third-party skills (the AgentMail pack) live only in the DB, never this public repo; ports keep their AGPL attribution.
