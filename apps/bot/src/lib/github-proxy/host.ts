// The only hosts the PAT may ever be sent to. `github.io` is deliberately absent:
// it serves anyone's Pages site, so a credential sent there is a credential
// handed to whoever owns that site.
const CREDENTIALED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'uploads.github.com',
]);

/**
 * Whether the PAT may ride on a request to `upstream`. Every upstream is built
 * from a fixed `https://<host>/` prefix, so today this cannot fail — it is the
 * belt to that braces (owner's ask, 2026-09-29, after coolton's proxy leaked its
 * PAT through a host two URL parsers read differently). It checks with the SAME
 * parser `fetch` uses, so what is checked is exactly where the bytes go.
 */
export function mayCarryPat(upstream: string): boolean {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    CREDENTIALED_HOSTS.has(url.hostname)
  );
}
