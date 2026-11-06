---
name: media-clips
description: 'Getting a GIF, clip, meme or video for someone: make it yourself from the source with yt-dlp + ffmpeg and upload it, how to get past YouTube''s "not a bot" wall with the browser''s cookies, and which hosts not to retry. Load before hunting for a GIF or downloading a video.'
---

# GIFs, clips and video

Someone asking for "the GIF" or "a clip of that" wants a FILE in the thread, not a list of GIF sites you couldn't open.

1. **Find the source, then make it.** Once you know the video (a YouTube link, a tweet, a page with a video), download it and cut what they asked for yourself:
   - `yt-dlp -f 'bv*[height<=720]+ba/b[height<=720]' -o src.mp4 '<url>'` (add `--download-sections '*0:10-0:20'` for just a part).
   - A GIF: `ffmpeg -ss 10 -t 5 -i src.mp4 -vf "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 out.gif`. Keep it under ~15 MB (shorter, smaller or lower fps if not).
   - Then `uploadFile`. Making the file is bash work (ImageMagick and ffmpeg are in the sandbox), not the coding agent.
2. **YouTube says "Sign in to confirm you're not a bot" (or 429).** The `browser` tool's stealth Chromium gets through where yt-dlp doesn't. Open the video in it once (`browser open <url>`), then hand its cookies to yt-dlp and retry ONCE:
   ```
   agent-browser cookies get --json | jq -r '"# Netscape HTTP Cookie File", (.data.cookies[] | [.domain, (if (.domain|startswith(".")) then "TRUE" else "FALSE" end), .path, (if .secure then "TRUE" else "FALSE" end), (if .session then 0 else (.expires|floor) end), .name, .value] | @tsv)' > /tmp/cookies.txt
   yt-dlp --cookies /tmp/cookies.txt ...
   ```
   These are the sandbox browser's own visitor cookies (it is signed in to nothing), so they help with the bot check, not with private or members-only videos. Still blocked after that: say so, with the source link.
3. **A host that failed once is done for this turn.** A DNS failure ("Could not resolve"), a Cloudflare 403 ("Attention Required!") or a block page from `fetchUrl` will be the same from the browser a minute later. Don't re-probe it with another tool; go to step 1 with the source instead. GIF aggregators (gifsea, yarn/getyarn, clipzag) are the usual ones that block.
4. **If every route fails**, say plainly what you have and what you couldn't verify. Never present a GIF or link you couldn't open as if you had checked it.
