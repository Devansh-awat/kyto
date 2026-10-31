---
name: sandbox-jobs
description: 'Sandbox how-tos: code mode (one script instead of many tool calls), slow commands in the background, out-of-memory (exit 137) recovery, and the read-only `slack <method> ''<json>''` command. Load before a long or batch job, after an exit 137, or before using the slack command.'
---

# Sandbox jobs

## Code mode

CODE MODE. Prefer ONE script over many tool calls. When a task means "do X across N things", loops or branches over results, or would be a long series of browser/fetch/file calls, use the `codeMode` tool: write ONE TypeScript program that does the whole job and prints its result, instead of calling a tool per step. Each tool call is a full model round-trip that can hit a rate limit or the step ceiling mid-way; a script does it all in one execution. Example: to read a captcha shown at 50 slider positions, DON'T click and screenshot 50 times: script it (drive the canvas / decode the data in code, or loop screenshots) and return the readable one. In codeMode you can `import { sh, slack } from './kyto.ts'` (shell + READ-ONLY Slack), use `fetch`, and drive `cloakbrowser`. codeMode can't post/DM/edit Slack. Do outward actions with the real tools afterward. A folder of documents to review or compare (past exams, papers, a pile of PDFs/DOCX) is the same: ONE script that lists the files, extracts each one's text (`pdftotext` if present; a DOCX is a zip: read its `word/document.xml`), says which yielded nothing, tallies what you're looking for, and prints a compact file × topic table, not one bash call per file.

## Slow commands

Don't block the whole turn on a slow command. A `bash` call holds up the turn until it returns, so a benchmark, a stress test, or anything that could run for minutes freezes your turn with nothing shown to the user. As a safety net, a foreground `bash` command still running after ~1 minute is AUTOMATICALLY moved to the background: instead of its output you'll get a handle id and `running: true`, and you poll it with `process` (action `output`) / stop it with `process` (action `kill`). Do NOT just re-run it. But don't lean on that auto-move: for anything you expect to be slow, be deliberate: cap it with `timeout` (e.g. `timeout 60 ./control.sh`) so a pathological input can't run forever, or start it yourself with `process` (action `start`) and keep working while it runs. A background job that is still going when your turn ends keeps running: you are woken with its result when it finishes, or told after 30 minutes if it hasn't. So you can finish your reply instead of waiting on it. If you're benchmarking someone else's code as a control, assume it may be pathologically slow on large inputs and bound its runtime.

## Out of memory

The sandbox has 1 GB of RAM and 2 CPUs. Exit code 137 (or "Killed", or the coding agent "killed, most likely out of memory") means the kernel OOM-killed the process: retrying the same thing dies the same way. Free memory first: close the browser (`agent-browser close`) and stop dev servers or leftover background jobs before a build, a solver or a `codingAgent` run, and never run Chromium alongside one. Then retry lighter: one worker, smaller batches, no headless browser where a plain script can do it. If it still dies, add swap (`sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`). CPU-bound work (proof-of-work, hashing) gets slower, not faster, with more parallel tabs or workers than the 2 cores.

## The `slack` command

A `slack <method> ['<json object>']` command is on PATH in the sandbox. It queries the Slack Web API READ-ONLY through kyto's host-side proxy (the bot token never enters the sandbox, and posting/editing is impossible through it). It works from the `bash` tool, the `slackScript` tool, and from a scheduled `bash` reminder. So a recurring reminder CAN recompute a live Slack number on every fire.
It is NOT curl and NOT the official Slack CLI: it takes exactly two arguments, a method name and one single-quoted JSON object, and NO flags: `slack conversations.replies --verbose '{...}'` is a usage error, not a proxy failure. Run `slack --help` for the usage and the full list of allowed methods; it is the fastest way to answer "can I call this?". A method it refuses is one the proxy does not forward at all (every write method, and search; there is no search here), so retrying it a different way will not work.
