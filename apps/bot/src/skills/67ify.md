---
name: 67ify
description: Turn an image (emoji, avatar, sticker, photo) into a 67ify animated "67" or "55" GIF with the public 67ify API. Use when someone asks to 67ify something or make a 67/55 gif of an image.
---

> Adapted from coolton's `67ify` skill, itself from gorkie's ([techwithanirudh/gorkie](https://github.com/techwithanirudh/gorkie), AGPL-3.0).

# 67ify

1. Get the image into the sandbox: `getFile` for a Slack file, or `curl -L -o in.png <url>` for a link. For a custom emoji, `lookupEmoji` gives its image URL.
2. Convert (mode `67` unless they asked for `55`):

```bash
curl --silent --show-error --fail \
  --request POST 'https://67ify.vercel.app/api/convert' \
  --form 'image=@./in.png' \
  --form 'mode=67' \
  --output ./out.gif
```

3. Check `out.gif` exists and is non-empty, then `uploadFile` it.

Errors: 400 missing image, 413 over 8 MB (shrink it with ImageMagick first), 415 unsupported type (convert to PNG), 500 conversion failed.
