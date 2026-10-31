---
name: slack-formatting
description: 'Block Kit `blocks` for postMessage: when a layout beats markdown (header, fields, divider, image, buttons) and the rules. Load before sending blocks.'
---

# Slack formatting

- postMessage also takes `blocks`: a Block Kit JSON array (max 50 blocks), for when a layout does more than markdown can: a header, fields, a divider, an image, a context line, buttons. The markdown `message` is still required and becomes the notification fallback text. Prefer plain markdown for ordinary replies; reach for blocks when the structure is the point.
