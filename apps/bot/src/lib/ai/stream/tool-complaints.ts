// Keep "I have no tools" out of a reply a person reads.
//
// kyto has three PROSE-ONLY recovery calls — finish the sentence you were cut off
// mid-way through, write the report you skipped (a subagent's, an agent
// reminder's) — where the work is already done and only the words are missing.
// Those used to be made with `tools: {}`, which contradicted the system prompt
// sitting right above them (it describes fifty tools and says to call
// `loadTools`), and weaker models resolved the contradiction by narrating it:
// "no tools loaded", or the observed "getFile isn't available… loadTools isn't
// available either… No tools available? That's strange".
//
// **The contradiction itself is gone**: every one of those calls now carries the
// REAL toolset (owner's call, 2026-08-22 — "NEVER LAUNCH MODELS WITHOUT tools"),
// and their prompts ask for prose without ever mentioning tools, since naming the
// thing you forbid is how it kept ending up in the output.
//
// This module is the part that CANNOT regress. It has been fixed at the prompt
// level three times now — a notice saying tools are off deliberately, then
// keeping tools ON for synthesizeFinalAnswer (ea22baf), then the above — and it
// came back each time, for two reasons no rewording addresses. Prompt wording
// cannot GUARANTEE anything about a weak model's output, and each fix only
// covered whichever call site happened to be hot that week: the truncated-reply
// continuation was near-dormant until a cut-off Zen stream started routing into
// it, at which point the same sentence reappeared from a path nobody had touched.
// So the guarantee lives at the point reply text is emitted.
//
// SCOPE IS WHAT MAKES IT SAFE. It runs only where the CALLER declares the call
// prose-only (`dropToolComplaints`, or `stripToolComplaints` over collected text).
// On such a call a sentence about tool availability cannot be a legitimate answer
// — and now that tools are always registered, it is also simply false. On a normal
// turn nothing is filtered, so "which tools do you have?" still gets an honest
// answer.

// A complaint is one short sentence. Anything longer is a real paragraph that
// happens to mention tools, and eating it would be far worse than leaving it.
const MAX_COMPLAINT_CHARS = 200;

// "tool" / "tools" / "toolset" — the subject of the complaint.
const TOOL_WORD = /\btool(?:s|set|sets)?\b/i;

// Language of absence. Deliberately broad: on a no-tools call there is no
// legitimate sentence that pairs one of these with the word "tool". The
// contractions share one suffix group (`…n't`, curly apostrophe or none) rather
// than being spelled out one by one.
const ABSENCE =
  /\b(?:no|none|not|unavailable|missing|disabled|off|without|lack|lacking|removed|denied|blocked|restricted|cannot|can['’]?t|(?:is|are|was|were|do|does|did|could|should|would|have|has)n['’]?t)\b/i;

// "getFile isn't available", "loadTools is not available" — the model naming a
// specific camelCase tool it reached for. These never mention the word "tool",
// which is exactly how the observed spiral slipped past a tool-word-only check.
//
// CASE-SENSITIVE ON PURPOSE — no `i` flag. camelCase is the whole signal, and an
// `i` flag makes `[a-z]` match capitals too, which degraded this into "any
// capital-letter word near the word available". Checked against real persisted
// reasoning, the `i` version matched `slack: 'admin.emoji.remove' is not
// available`, `Search token expired or not available`, `Chat Not available in
// this workspace`, and `If Porkbun says not available and the registry says
// taken` — every one a legitimate sentence about something other than kyto's
// toolset. The gap is short for the same reason: the absence has to be ABOUT the
// identifier, not merely in the same sentence as it.
const IDENTIFIER_UNAVAILABLE =
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b[^.!?\n]{0,24}?\b(?:is|are|was|were|seems? to be)?\s*(?:n['’]?t|not)?\s*(?:available|registered|enabled|accessible|working|there|loaded)\b/;

/** Is this one sentence nothing but a complaint about tools being missing? */
export function isToolComplaint(sentence: string): boolean {
  const text = sentence.trim();
  if (!text || text.length > MAX_COMPLAINT_CHARS) {
    return false;
  }
  if (TOOL_WORD.test(text) && ABSENCE.test(text)) {
    return true;
  }
  // The identifier form only counts alongside absence language, or "loadTools
  // is available" (a true statement on a normal turn) would match too.
  return IDENTIFIER_UNAVAILABLE.test(text) && ABSENCE.test(text);
}

export interface ComplaintSplit {
  /** What was dropped, for the log. */
  dropped: string;
  /** Text safe to show the user. */
  text: string;
}

// Sentence end, or a line break — a model writing a bullet list of grievances
// puts one per line with no full stop.
const AFTER_BOUNDARY = /(?<=[.!?\n])/;
const LAST_BOUNDARY = /[.!?\n][^.!?\n]*$/;

/**
 * Streaming filter: feed it text deltas, get back what may be shown. It holds
 * the tail after the last sentence boundary, because a sentence cannot be judged
 * until it is whole — so a complaint is never half-posted and then retracted.
 */
export function createToolComplaintFilter() {
  let buffer = '';

  const drain = (final: boolean): ComplaintSplit => {
    // Everything up to the last boundary is complete and can be judged; the
    // remainder waits for more deltas (or, at flush, is judged as-is).
    let complete = buffer;
    if (final) {
      buffer = '';
    } else {
      const match = LAST_BOUNDARY.exec(buffer);
      const end = match ? match.index + 1 : 0;
      complete = buffer.slice(0, end);
      buffer = buffer.slice(end);
    }
    if (!complete) {
      return { dropped: '', text: '' };
    }
    const units = complete.split(AFTER_BOUNDARY);
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const unit of units) {
      if (isToolComplaint(unit)) {
        dropped.push(unit);
      } else {
        kept.push(unit);
      }
    }
    // Nothing matched: return the input byte-for-byte, so the common case is a
    // pure passthrough and cannot alter a reply's whitespace.
    if (dropped.length === 0) {
      return { dropped: '', text: complete };
    }
    return { dropped: dropped.join(''), text: kept.join('') };
  };

  return {
    /** Feed one text delta; returns what may be shown and what was dropped. */
    push(chunk: string): ComplaintSplit {
      buffer += chunk;
      return drain(false);
    },
    /** End of stream: judge and release the held-back tail. */
    flush(): ComplaintSplit {
      return drain(true);
    },
  };
}

/**
 * Same rule over a whole string, for the recovery paths that collect their text
 * instead of streaming it (an agent reminder's report nudge, a subagent's).
 */
export function stripToolComplaints(text: string): string {
  const filter = createToolComplaintFilter();
  const streamed = filter.push(text);
  const rest = filter.flush();
  return `${streamed.text}${rest.text}`;
}
