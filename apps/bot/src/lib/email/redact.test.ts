import { describe, expect, it } from 'bun:test';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('redacts hyphenated codes after a label (Slack sends XXX-XXX)', () => {
    // This exact email leaked a real one-time code before the fix.
    const mail =
      'Hi Kyto, use the link below to log in. Your login code is 393-403.\nhttps://hackclub.slack.com/magic-link/abcdef';
    const { redactions, text } = redactSecrets(mail);
    expect(redactions).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain('393-403');
    expect(text).not.toContain('393');
    expect(text).toContain('[redacted: possible auth code]');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('redacts a bare hyphenated code on its own line', () => {
    const mail = 'Enter this code:\n\n482-915\n\nThanks!';
    const { redactions, text } = redactSecrets(mail);
    expect(redactions).toBe(1);
    expect(text).toBe('Enter this code:\n\n[redacted: possible auth code]\n\nThanks!');
  });

  it('still redacts plain 4-8 digit codes and labelled tokens', () => {
    expect(redactSecrets('your verification code: 84213').text).not.toContain('84213');
    expect(redactSecrets('code\n\n123456\n').text).toContain('[redacted: possible auth code]');
  });

  it('does not redact ordinary prose near the word "code"', () => {
    // A 3-char minimum is the cost of catching XXX-XXX; make sure we don't
    // mangle sentence text that merely mentions the word.
    const { redactions } = redactSecrets(
      'The discount code SPRING expires soon, see https://example.com/shop'
    );
    expect(redactions).toBe(0);
  });

  it('redacts password-reset links', () => {
    const mail =
      'Reset your password: https://example.com/reset/9f3a1c77b2ee4d0a99ca5e8f1234abcd';
    const { text } = redactSecrets(mail);
    expect(text).toContain('[redacted: possible auth link]');
    expect(text).not.toContain('9f3a1c77');
  });

  it('leaves ordinary links alone', () => {
    const mail = 'Read the docs at https://example.com/docs/getting-started please.';
    const { redactions, text } = redactSecrets(mail);
    expect(redactions).toBe(0);
    expect(text).toContain('https://example.com/docs/getting-started');
  });

  it('handles empty input', () => {
    expect(redactSecrets(undefined)).toEqual({ redactions: 0, text: '' });
    expect(redactSecrets('')).toEqual({ redactions: 0, text: '' });
  });
});
