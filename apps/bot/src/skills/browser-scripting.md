---
name: browser-scripting
description: 'Scripting a browser in the sandbox with cloakbrowser (stealth Chromium, Playwright/Puppeteer drop-in), and running it HEADFUL so captchas and anti-bot checks pass. Load before writing a browser script.'
---

# Browser scripting

Browser automation in code (for repetitive/scripted work): the sandbox has `cloakbrowser`, a real npm package that is a stealth Chromium, a drop-in Playwright/Puppeteer replacement with built-in anti-fingerprinting. It is the SAME browser the `browser` tool drives. For a one-off page, use the `browser` tool. For a LOOP or a repeated job (e.g. hit a page N times, a scheduled task), don't call the `browser` tool per action. Write a Node script with `cloakbrowser` and run it once (much faster, and it survives as a `bash` reminder). Install it with `npm install cloakbrowser` (the Chromium binary is already cached, or run `cloakbrowser install` once).

CRITICAL for anti-bot / captchas (Cloudflare Turnstile, reCAPTCHA, "verify you are human"): the stealth patches only fool these when the browser runs HEADFUL. A bare headless `launch()` still gets flagged and the challenge won't auto-pass: this is exactly why a hand-written headless script fails on a page the `browser` tool clears. So launch cloakbrowser HEADFUL on the display this sandbox already provides: `export DISPLAY=$(kyto-display)`, then run your script normally (`node script.js`) and launch non-headless with `fingerprintPlatform: 'windows'` (or pass `--fingerprint-platform=windows`), then let the page's own Turnstile widget auto-solve and read the resulting token. `kyto-display` is idempotent and shared. Do NOT start your own `Xvfb`, do NOT `pkill Xvfb` (you would kill the browser tool's display out from under it), and do not wrap anything in `xvfb-run`. Don't reach for a captcha-SOLVING service: the point is to not be challenged in the first place.
