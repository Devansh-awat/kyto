import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Any URL the BOT fetches on someone's say-so (an MCP server, `fetchUrl`, a
// 'script' reminder, a BYOK base URL) is fetched from inside kyto's own
// network, and whatever comes back is handed to the model and then into a Slack
// thread. That makes an unchecked URL a straightforward read primitive against
// everything kyto's container can reach: the Docker/Coolify control plane on the
// same network, another container's admin port, the host's cloud metadata
// endpoint. Not blind SSRF — the response is printed back.
//
// So the host has to be public. This is checked twice on purpose: once when a
// URL is SAVED, so a person gets a clear error instead of a mysterious dead
// server, and once when it is actually FETCHED, because a hostname that
// resolved publicly at save time can resolve to 127.0.0.1 later (a name is not
// a promise). Neither check is a substitute for the other. Redirects are
// followed by hand so every hop is checked — `fetch`'s own follow would let a
// public server 307 straight to 169.254.169.254.

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

const NOT_PUBLIC_REASON =
  'That address is on Kyto’s own network, so it can’t be used. Use a public URL.';

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

const IPV6_GROUPS = 8;
const BYTE = 256;

/** The eight 16-bit groups of an address `isIP` already accepted as v6. */
function ipv6Groups(address: string): number[] {
  let value = address.split('%')[0] ?? '';
  // A dotted IPv4 tail (`::ffff:10.0.0.1`) is two more groups.
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (tail) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.slice(1).map(Number);
    const high = (a * BYTE + b).toString(16);
    const low = (c * BYTE + d).toString(16);
    value = `${value.slice(0, tail.index)}${high}:${low}`;
  }
  const [head = '', rest] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const zeros =
    rest === undefined ? 0 : IPV6_GROUPS - left.length - right.length;
  return [...left, ...new Array<string>(zeros).fill('0'), ...right].map(
    (group) => Number.parseInt(group, 16)
  );
}

function ipv4FromGroups(high: number, low: number): string {
  return [
    Math.floor(high / BYTE),
    high % BYTE,
    Math.floor(low / BYTE),
    low % BYTE,
  ].join('.');
}

// An ALLOWLIST, not a denylist: only global unicast (2000::/3) is public. The
// denylist this replaced matched `::ffff:127.0.0.1` with a regex, but the URL
// parser rewrites that literal to `::ffff:7f00:1` before it is ever checked, so
// the mapped, NAT64 and site-local spellings of loopback and metadata all got
// through.
function isPrivateIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  const [first = 0, second = 0, third = 0] = groups;
  // IPv4-mapped (::ffff:a.b.c.d) tunnels straight back to the v4 ranges.
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xff_ff;
  if (mapped) {
    return isPrivateIpv4(ipv4FromGroups(groups[6] ?? 0, groups[7] ?? 0));
  }
  if (first < 0x20_00 || first > 0x3f_ff) {
    return true;
  }
  if (first === 0x20_01 && (second === 0 || second === 0x0d_b8)) {
    return true; // Teredo, documentation
  }
  if (first === 0x20_02) {
    return isPrivateIpv4(ipv4FromGroups(second, third)); // 6to4
  }
  return false;
}

/** Is this literal IP address one the bot must never be pointed at? */
export function isPrivateAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, '');
  const family = isIP(value);
  if (family === 4) {
    return isPrivateIpv4(value);
  }
  if (family === 6) {
    return isPrivateIpv6(value);
  }
  return false;
}

export type PublicUrlCheck =
  | { ok: false; reason: string }
  | { ok: true; url: URL };

/**
 * The cheap, synchronous half: shape, scheme, and anything that is obviously an
 * internal name or a private literal address. Runs when a URL is saved.
 */
export function checkPublicUrl(raw: string | undefined): PublicUrlCheck {
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
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!hostname) {
    return { ok: false, reason: 'Enter an http(s) URL.' };
  }
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isPrivateAddress(hostname)
  ) {
    return { ok: false, reason: NOT_PUBLIC_REASON };
  }
  return { ok: true, url };
}

// Verdicts are memoized briefly: every MCP JSON-RPC call re-checks, and a turn
// can make many. Short enough that a hostname re-pointed at an internal address
// is caught within the minute, which is the same window the failure cache uses.
const RESOLVE_TTL_MS = 60_000;
const verdicts = new Map<string, { at: number; error?: string }>();

/**
 * The fetch-time half: resolve the name and refuse if it lands anywhere
 * private. Called before every fetch of a user-supplied URL.
 */
export async function assertPublicHost(rawUrl: string): Promise<void> {
  const checked = checkPublicUrl(rawUrl);
  if (!checked.ok) {
    throw new Error(checked.reason);
  }
  const hostname = checked.url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    return;
  }
  const cached = verdicts.get(hostname);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) {
    if (cached.error) {
      throw new Error(cached.error);
    }
    return;
  }
  const addresses = await lookup(hostname, { all: true }).catch(() => []);
  let error: string | undefined;
  if (addresses.length === 0) {
    error = `Could not resolve ${hostname}.`;
  } else if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    error = `${hostname} resolves to an address on Kyto’s own network, so it can’t be used.`;
  }
  verdicts.set(hostname, { at: Date.now(), error });
  if (error) {
    throw new Error(error);
  }
}

const MAX_REDIRECTS = 5;

/**
 * `fetch` for a user-supplied URL: the host is checked before the first
 * request and again before every redirect hop.
 */
export async function publicFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current);
    const response = await fetch(current, { ...init, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }
    await response.body?.cancel();
    current = new URL(location, current).toString();
  }
  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
}
