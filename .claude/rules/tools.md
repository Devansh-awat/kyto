---
paths:
  - "apps/bot/src/lib/ai/**"
  - "apps/bot/src/lib/skills/**"
  - "apps/bot/src/skills/**"
---

# Tool verbs, todo, repeat cache, workspace files, skills

Part of the project notes (`.claude/CLAUDE.md`); loaded when you work on these files. Keep it current in the same change as the feature.

- **No tool families** (split 2026-11-11, #184): each verb (`saveMemory`, `scheduleReminder`, `canvasWrite`, …) is its own tool with its own required fields. A flat `action` schema made every field optional, and GLM sent `memory edit` without `title` ~15 times a turn. Rule: a field the code needs is `required` in the schema; never `.optional()` plus a runtime "needs X" check, and no `action` enum whose verbs need different fields. Old family names in `thread_loaded_tools` map to their verbs (`RETIRED_FAMILIES`, `toolset.ts`). `usage`, `CODE_TOOLS`, `SLACK_READ_TOOLS`, `PUBLIC_POSTING_TOOLS` and the plan renderers all speak the verb names directly.
- **`todo`** (owner's ask 2026-10-16): a live checklist (workspace emoji `checked-t`/`loading`/`unchecked-t` in one rich_text; the plan block collapses), only for LARGE tasks (4+ parts, many minutes), kept at the bottom of the thread (reposted under anything newer mid-turn); deleted when finished, an unfinished one handed to the next turn (TOOLS.md).
- **An identical Slack read, web search or fetch** (`SLACK_READ_TOOLS` + `searchWeb` + `fetchUrl` (#180), same input) within 5 min of the turn is answered from the turn's copy, marked `repeated` (owner's call 2026-10-26: a repeat, not a cap); any `EFFECT_TOOLS` call (incl. `wait`) clears the copies; never across turns (#119).
- **`uploadFile`** never brings the file into kyto: the host gets Slack's presigned upload URL (`files.getUploadURLExternal`; the bot token stays on the host, the URL is one-shot for that file), the SANDBOX sends the bytes with `curl -T` (streams; `--data-binary` would read it whole), and the host completes the upload only if Slack's `OK - <bytes>` answer matches the stat'd size (a short body is otherwise published looking intact). Read into kyto's heap, one 385 MB pack OOM-killed the 2 GiB pod four times running on 2026-10-27. It stat-checks first (`session.fileSize`, polled while a sibling call writes the file) and refuses over `MAX_UPLOAD_BYTES` (1 GB, Slack's own limit). Not serialized any more: nothing is buffered.
- **Workspace files** (`tools/workspace-files.ts`, TOOLS.md): `editFile`/an overwriting `writeFile` need a `readFile` of that file THIS TURN and refuse if it changed since; `readFile` is line-numbered; `grep`/`glob` run ripgrep with the model's values only as quoted arguments; `bash` takes `timeout`.
- **Skills** (`lib/skills/`, `skills` table): `loadSkill` (core; the index IS its description, sorted — tool schemas are cached prefix) and the skill tools `installSkill` / `listSkills` / `removeSkill` / `showSkill` / `writeSkill` (**owner-only registration**: a skill is prompt text every turn loads). Built-ins = `apps/bot/src/skills/*.md` (a bad one fails boot); owner rows add/override. Install only from GitHub over https (`githubSkillSource`, tested). Unlicensed third-party skills (the AgentMail pack) live only in the DB, never this public repo; ports keep their AGPL attribution.
