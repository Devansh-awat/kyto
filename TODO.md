# Kyto TODO

## When something is done, remove it from here
## how this works: i put my ideas, problems, etc here, then every 2 or so days i ask claude(you) to fix it. 

### Open

**Decide the gorkie-provenance question before making the repo public.** The
licence is written (`LICENSE`, source-available/all-rights-reserved, per owner:
readable but nobody may copy or use it) and the secrets audit is clean — see
`docs/reference/publishing.md`. What is NOT settled: kyto forked MIT-licensed
gorkie and still carries its whole history, so gorkie-derived code stays MIT
(`LICENSE-gorkie-MIT`) and that carve-out can't be waved away. The harness is a
ground-up rewrite so the surviving fraction may be ~zero, but nobody has measured
it. Also: `.agents/skills/` vendors third-party skills with undocumented
provenance — document or drop them.

**"Thinking..." shows as plain text before the plan block appears**, and when
the block does appear it already has thinking in it. Investigated: no such
string exists anywhere in kyto, and the first plan chunk is already pulled
before the stream opens, so this looks like Slack's own placeholder for an open
`chatStream` that has not rendered yet. Needs confirming against a real thread
before there's anything to fix. Ideally show a real loading message instead.

**Thinking cards render as a single line.** Worth confirming this is genuinely
one line of reasoning (gpt-5.6 returns short `reasoningSummary` text, so it
probably is) rather than longer thinking being truncated somewhere. Try again
and look at the raw response.

**HackClub served opus-4.5 for a request.** A turn came back as
`(Empty response: {'content': [], 'model': 'claude-opus-4-5-20251101'})`. Kyto
never asks for 4.5 — it isn't in `LEADERBOARD_FALLBACK` — so the proxy resolved
one of our slugs to it upstream. The placeholder text is already filtered and
the empty response already falls back, so this is a "what is HackClub doing"
question, not a kyto bug.

### Watch list

**The ChatGPT account is parked until 2026-08-23.** The linked account is on a
FREE plan and its quota is spent; the 429 named that reset date, which is now
stored in `user_chatgpt_accounts.quota_resets_at` and the attempt is skipped
until then. If ChatGPT turns are wanted before that, the account needs a paid
plan. A completed turn clears the park automatically.

HOW MANY FALLBACKS
Thinkingmoonshotai/kimi-k2.7-code
ThinkingThe user is asking me to check my mail. I have email tools available (checkInbox, readEmail, replyEmail, sendEmail) but they're deferred tools that need to be loaded first. Let me load the email tools and then check the inbox.
loadToolsCompleted.
ThinkingTools loaded. Now check the inbox.
checkInboxCompleted.
Thinking · fallbackkimi-k2.6
Thinking · fallbackdeepseek-v4-pro
Thinking · fallbackqwen3.5-397b-a17b
Thinking · fallbackminimax-m2.5
Thinking · fallbackglm-5
Thinking · fallbackdeepseek-v4-flash
Thinking · fallbackllama-4-maverick
Thinking · fallbackmimo-v2.5-pro
Thinking · fallbackopenai/gpt-5.6-sol
Thinking · fallbackgemini-3.1-flash-lite
readEmailCompleted.
readEmailCompleted.
readEmailCompleted.

not just fallbacks, but issue with browser too?
Thinking · fallbackqwen3.5-397b-a17b
Thinking · fallbackminimax-m2.5
Thinking · fallbackglm-5
Thinking · fallbackdeepseek-v4-flash
Thinking · fallbackllama-4-maverick
Thinking · fallbackmimo-v2.5-pro
Thinking · fallbackgemini-3.1-flash-lite
loadToolsCompleted.
browserbrowser: open https://brisharks.bribooks.com/startup/vote/insightbot-by-niraj-mukesh-gundecha/
Error: Could not start the stealth browser: cloakbrowser: could not install the stealth chr…
Running commandnpx cloakbrowser install
Completed.
browserbrowser: open https://brisharks.bribooks.com/startup/vote/insightbot-by-niraj-mukesh-gundecha/
Error: Could not start the stealth browser: cloakbrowser: could not install the stealth chr…
kyto  [4:45 PM]
I'm sorry, I'm unable to vote for that project. I've tried to access the page, but I'm encountering a technical issue with the browser tool that's preventing me from opening the site.

gemini-3.1-flash-lite
Running commandmkdir -p /home/user/node_modules/cloakbrowser/dist/chromium ; curl -L -o /home/user/chromium.ta…
Completed.
Running commandcurl -I https://brisharks.bribooks.com/startup/vote/insightbot-by-niraj-mukesh-gundecha/
Completed.
kyto  [5:29 PM]
I've investigated why the browser tool is failing, and it turns out the environment's network restrictions prevent the automatic download of the stealth browser's binary (which is quite large and hosted on GitHub/external CDN). Because that binary is required for the tool to function, I can't "fix" the tool itself—I don't have the permissions to modify the underlying sandbox infrastructure to bypass those network constraints.
kyto  [5:29 PM]
I can, however, confirm that the site is reachable via standard HTTP requests (it returns a 200 OK status).

Add optional skill or something that goes into details on block kit and slack search, its optional as without it also model knows stuff. while writing this, search official docs so that its up to date. and also on canvas as with canvas i told it to put checkbox and it used emojis not the proper clickable checkbox

there was a canvasid issue idk if you fixed it

have kyto run daily once, being told to check mail and github incase any issues, responses or pr stuff in its repo or others(this should run in such a way that its visible in my dm from kyto)

no name suffix but change the pic for normal kyto too. 