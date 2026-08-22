import { describe, expect, test } from 'bun:test';
import {
  createToolComplaintFilter,
  isToolComplaint,
  stripToolComplaints,
} from './tool-complaints';

// The exact sentences observed in production, and the ones that must survive.
// This has regressed several times as a prompt-wording fix, so the point of
// these tests is that the DROP is pinned down and cannot quietly stop working.
describe('isToolComplaint', () => {
  test('drops the sentences kyto actually posted', () => {
    const complaints = [
      'no tools loaded',
      'No tools loaded.',
      'It seems I have no tools available.',
      'I do not have any tools for this message.',
      'My tools appear to be disabled right now.',
      "I can't use tools here.",
      'Tools are unavailable, which is strange.',
      'getFile is not available.',
      "loadTools isn't available either.",
      'No tools available? That is strange.',
      // Curly apostrophes: what a model actually emits more often than not.
      'I don’t have tools right now.',
      'Tools aren’t available for this message.',
      // "toolset" is the same complaint by another name.
      'My toolset is disabled.',
    ];
    for (const line of complaints) {
      expect(isToolComplaint(line)).toBe(true);
    }
  });

  test('keeps real prose that happens to mention tools', () => {
    const keep = [
      'I used the bash tool to run the tests and they all passed.',
      'The repo has no test tooling configured, so I added bun test.',
      'yt-dlp and ffmpeg are both installed in the sandbox.',
      'Here are the three tools you asked about: bash, browser, and gh.',
      // Long enough to be a real paragraph, so it is left alone even though it
      // pairs "tool" with absence language.
      'I looked into why the deploy failed and the short version is that the build container has no tools for compiling native modules, which is why node-gyp died partway through the install step and took the whole image build with it.',
    ];
    for (const line of keep) {
      expect(isToolComplaint(line)).toBe(false);
    }
  });

  test('an identifier alone is not a complaint', () => {
    // Without absence language this is a normal statement, and on a real turn
    // it is even true.
    expect(isToolComplaint('loadTools is available.')).toBe(false);
    expect(isToolComplaint('I called getFile and it worked.')).toBe(false);
  });
});

describe('createToolComplaintFilter', () => {
  test('drops a complaint mid-reply and keeps the rest', () => {
    const filter = createToolComplaintFilter();
    const first = filter.push('The tests pass. No tools loaded. All 12 green.');
    const rest = filter.flush();
    // The space after a boundary belongs to the sentence that follows it, so
    // dropping one leaves normal single spacing rather than a gap.
    expect(`${first.text}${rest.text}`).toBe('The tests pass. All 12 green.');
    expect(first.dropped + rest.dropped).toContain('No tools loaded.');
  });

  test('holds an incomplete sentence until it can be judged', () => {
    const filter = createToolComplaintFilter();
    // The complaint arrives split across deltas; nothing may leak in between.
    const a = filter.push('Done. No tools');
    expect(a.text).toBe('Done.');
    const b = filter.push(' loaded.');
    expect(b.text).toBe('');
    expect(b.dropped).toBe(' No tools loaded.');
    expect(filter.flush().text).toBe('');
  });

  test('a reply with no complaint passes through byte for byte', () => {
    const filter = createToolComplaintFilter();
    const input =
      'Ran the build.\n\nIt passed, 6 packages, 20s.  Nothing else.';
    const streamed = filter.push(input);
    const rest = filter.flush();
    expect(`${streamed.text}${rest.text}`).toBe(input);
    expect(streamed.dropped + rest.dropped).toBe('');
  });

  test('handles a bulleted list of grievances with no full stops', () => {
    const filter = createToolComplaintFilter();
    const streamed = filter.push(
      'Here is what I found:\n- getFile is not available\n- the log is empty\n'
    );
    const rest = filter.flush();
    expect(`${streamed.text}${rest.text}`).toBe(
      'Here is what I found:\n- the log is empty\n'
    );
  });
});

describe('stripToolComplaints', () => {
  test('applies the same rule to collected text', () => {
    expect(
      stripToolComplaints('Checked the queue, nothing new. No tools loaded.')
    ).toBe('Checked the queue, nothing new.');
  });

  test('leaves an ordinary report untouched', () => {
    const report = 'Checked the queue: 3 new rows, all processed.';
    expect(stripToolComplaints(report)).toBe(report);
  });
});
