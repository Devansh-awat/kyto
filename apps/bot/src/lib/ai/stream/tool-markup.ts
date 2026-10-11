// Keep a model's own tool-call markup out of the reply.
//
// A provider is supposed to return tool calls in the `tool_calls` field, which
// the SDK turns into `tool-call` stream parts. When that goes wrong the model
// writes its NATIVE markup into the content channel instead, and kyto streamed
// it straight into Slack. A real turn ended with several screens of:
//
//   <｜DSML｜tool_calls>
//   <｜DSML｜invoke name="postMessage">
//   <｜DSML｜parameter name="message" string="true">…
//
// repeated with one more character each time, because the harness never
// answered a call it never saw, so the model retried into the void.
//
// The tell is the character after `<`: U+FF5C FULLWIDTH VERTICAL LINE. Every
// family that leaks does this — DeepSeek's `<｜tool▁calls▁begin｜>`, the
// `<｜DSML｜…>` above — and no prose kyto should ever post contains it.
//
// Claude is the exception: its native markup is plain XML. Haiku 5.5, at
// reasoning effort `none`, posted a thread a bare `skip` followed by
// `<invoke name="skip"><parameter name="reason">…` as two Slack messages
// (2026-10-10). So its opening tags are markers too, with and without the `antml:` namespace. A reply quoting that markup
// on purpose loses its tail, which is the cheaper mistake.
//
// Once it appears, everything after it is markup: the model has stopped writing
// to the user and started writing to a parser that isn't listening. So the rest
// of the attempt's text is dropped rather than trimmed tag by tag — a partial
// strip would leave the arguments (a whole Block Kit payload, in that turn) in
// the reply. What is left of a leaked skip is the bare word, which the agent
// loop already turns into a real skip (skip-text.ts).

const MARKERS = ['<｜', '<invoke name=', '<function_calls>', '<antml:invoke'];

// How much of the buffer's tail could still grow into a marker.
function heldLength(buffer: string): number {
  let held = 0;
  for (const marker of MARKERS) {
    for (let length = marker.length - 1; length > held; length -= 1) {
      if (buffer.endsWith(marker.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  return held;
}

export interface MarkupSplit {
  /** Markup that was dropped, for the log. */
  dropped: string;
  /** Text safe to show the user. */
  text: string;
}

export function createToolMarkupFilter() {
  let buffer = '';
  let tripped = false;

  const drain = (final: boolean): MarkupSplit => {
    if (tripped) {
      const dropped = buffer;
      buffer = '';
      return { dropped, text: '' };
    }
    const found = MARKERS.map((marker) => buffer.indexOf(marker)).filter(
      (index) => index !== -1
    );
    if (found.length > 0) {
      tripped = true;
      const at = Math.min(...found);
      const text = buffer.slice(0, at);
      const dropped = buffer.slice(at);
      buffer = '';
      return { dropped, text };
    }
    // No marker yet. Release everything except a tail that could still become
    // one on the next delta.
    const hold = final ? 0 : heldLength(buffer);
    const text = buffer.slice(0, buffer.length - hold);
    buffer = buffer.slice(buffer.length - hold);
    return { dropped: '', text };
  };

  return {
    /** Feed one text delta; returns what may be shown and what was dropped. */
    push(chunk: string): MarkupSplit {
      buffer += chunk;
      return drain(false);
    },
    /** End of stream: release the held-back tail (a lone `<` is just text). */
    flush(): MarkupSplit {
      return drain(true);
    },
    /** Whether this attempt leaked tool markup at all. */
    get leaked(): boolean {
      return tripped;
    },
  };
}
