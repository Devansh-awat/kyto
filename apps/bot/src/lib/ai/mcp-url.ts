import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// An MCP server URL is fetched BY THE BOT, from inside the bot's own network,
// and whatever comes back is handed to the model and then into a Slack thread
// the person who configured it is reading. That makes an unchecked URL a
// straightforward read primitive against everything kyto's container can reach:
// the Docker/Coolify control plane on the same network, another container's
// admin port, the host's cloud metadata endpoint. Not blind SSRF — the response
// is printed back.
//
// So the host has to be public. This is checked twice on purpose: once when the
// entry is SAVED, so a person gets a clear error instead of a mysterious dead
// server, and once when it is actually CONNECTED, because a hostname that
// resolved publicly at save time can resolve to 127.0.0.1 later (a name is not
// a promise). Neither check is a substitute for the other.

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::' || value === '::1') {
    return true;
  }
  // IPv4-mapped (`::ffff:10.0.0.1`) tunnels straight back to the v4 ranges.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1]) {
    return isPrivateIpv4(mapped[1]);
  }
  return (
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') || // link-local fe80::/10
    value.startsWith('fc') ||
    value.startsWith('fd') // unique-local fc00::/7
  );
}

/** Is this literal IP address one the bot must never be pointed at? */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  return false;
}

export type McpUrlCheck =
  | { ok: false; reason: string }
  | { ok: true; url: URL };

/**
 * The cheap, synchronous half: shape, scheme, and anything that is obviously an
 * internal name or a private literal address. Runs when the entry is saved.
 */
export function checkMcpUrl(raw: string | undefined): McpUrlCheck {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Enter an http(s) URL.' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Enter an http(s) URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Enter an http(s) URL.' };
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    return { ok: false, reason: 'Enter an http(s) URL.' };
  }
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isPrivateAddress(hostname)
  ) {
    return {
      ok: false,
      reason:
        'That address is on Kyto’s own network, so it can’t be used. Use a public URL.',
    };
  }
  return { ok: true, url };
}

// Verdicts are memoized briefly: every JSON-RPC call re-checks, and a turn can
// make many. Short enough that a hostname re-pointed at an internal address is
// caught within the minute, which is the same window the failure cache uses.
const RESOLVE_TTL_MS = 60_000;
const verdicts = new Map<string, { at: number; error?: string }>();

/**
 * The connect-time half: resolve the name and refuse if it lands anywhere
 * private. Called from McpConnection before the first request of a turn.
 */
export async function assertPublicMcpHost(rawUrl: string): Promise<void> {
  const cached = verdicts.get(rawUrl);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) {
    if (cached.error) {
      throw new Error(cached.error);
    }
    return;
  }
  try {
    await resolvePublicHost(rawUrl);
    verdicts.set(rawUrl, { at: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    verdicts.set(rawUrl, { at: Date.now(), error: message });
    throw error;
  }
}

async function resolvePublicHost(rawUrl: string): Promise<void> {
  const checked = checkMcpUrl(rawUrl);
  if (!checked.ok) {
    throw new Error(checked.reason);
  }
  const hostname = checked.url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    return;
  }
  const addresses = await lookup(hostname, { all: true }).catch(() => []);
  if (addresses.length === 0) {
    throw new Error(`Could not resolve ${hostname}.`);
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(
      `${hostname} resolves to an address on Kyto’s own network, so it can’t be used.`
    );
  }
}
