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
// `<｜DSML｜…>` above — and no prose kyto should ever post contains it, so the
// marker is `<｜` and nothing more clever is needed.
//
// Once it appears, everything after it is markup: the model has stopped writing
// to the user and started writing to a parser that isn't listening. So the rest
// of the attempt's text is dropped rather than trimmed tag by tag — a partial
// strip would leave the arguments (a whole Block Kit payload, in that turn) in
// the reply.

const MARKER = '<｜';
// Only a trailing bare `<` can still become the marker, so at most one
// character is ever held back.
const MAX_HELD = MARKER.length - 1;

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
    const at = buffer.indexOf(MARKER);
    if (at !== -1) {
      tripped = true;
      const text = buffer.slice(0, at);
      const dropped = buffer.slice(at);
      buffer = '';
      return { dropped, text };
    }
    // No marker yet. Release everything except a trailing `<` that could still
    // become one on the next delta.
    const hold = !final && buffer.endsWith('<') ? MAX_HELD : 0;
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
