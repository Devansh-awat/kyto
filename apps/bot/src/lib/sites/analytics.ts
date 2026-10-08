import { addSiteHits, addSiteViews, pruneSiteHits } from '@repo/db/queries';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const FLUSH_MS = 60 * 1000;
const HIT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
// Requests in one flush window (a minute) that get logged as a possible flood.
const IP_SPIKE_PER_MINUTE = 600;
const TOTAL_SPIKE_PER_MINUTE = 6000;
// A flood from many (or spoofed) addresses must not grow this map without
// bound: past the cap, new addresses are counted under one bucket.
const MAX_PENDING_HITS = 20_000;
const OVERFLOW_IP = 'overflow';
// Link unfurlers and crawlers fetch a page the moment it's posted; counting
// them would make every site look visited once per share.
const NOT_A_PERSON =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python-requests|headless/i;

// Counted in memory and written once a minute: a page view must never wait on
// Postgres. A restart loses at most the last minute's counts.
const pending = new Map<string, number>();
const pendingHits = new Map<string, number>();
let lastPrune = 0;

/**
 * The visitor's address. Behind Coolify's proxy the socket peer is the proxy,
 * so it's the LAST X-Forwarded-For entry — the one our proxy appended; the
 * earlier ones are whatever the client claimed and are trivially spoofed.
 */
function clientIp({
  peer,
  request,
}: {
  peer: string | undefined;
  request: Request;
}): string {
  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  return (
    forwarded ?? request.headers.get('x-real-ip')?.trim() ?? peer ?? 'unknown'
  );
}

/**
 * Count EVERY request by client IP (internal only, never shown to site
 * creators): the way to tell a flood or a scraper from real traffic. `site` is
 * the first path segment, so the dashboard and proxies are counted too.
 */
export function recordSiteHit({
  peer,
  request,
}: {
  peer: string | undefined;
  request: Request;
}): void {
  const site = new URL(request.url).pathname.split('/')[1] || '/';
  const ip = clientIp({ peer, request });
  const day = new Date().toISOString().slice(0, 10);
  let key = `${site}\n${day}\n${ip}`;
  if (!pendingHits.has(key) && pendingHits.size >= MAX_PENDING_HITS) {
    key = `${site}\n${day}\n${OVERFLOW_IP}`;
  }
  pendingHits.set(key, (pendingHits.get(key) ?? 0) + 1);
}

async function flushSiteHits(): Promise<void> {
  if (pendingHits.size === 0) {
    return;
  }
  const rows = [...pendingHits].map(([key, requests]) => {
    const [site = '', day = '', ip = ''] = key.split('\n');
    return { day, ip, requests, site };
  });
  pendingHits.clear();
  // The window is one flush interval, so these are per-minute rates.
  const byIp = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    byIp.set(row.ip, (byIp.get(row.ip) ?? 0) + row.requests);
    total += row.requests;
  }
  const heavy = [...byIp]
    .filter(([, requests]) => requests >= IP_SPIKE_PER_MINUTE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (heavy.length > 0 || total >= TOTAL_SPIKE_PER_MINUTE) {
    logger.warn(
      { heavy: Object.fromEntries(heavy), total },
      '[sites] request spike in the last minute'
    );
  }
  await addSiteHits(rows).catch((error: unknown) => {
    logger.warn(
      { err: errorMessage(error), rows: rows.length },
      '[sites] could not save request counts'
    );
  });
  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = Date.now();
    const cutoff = new Date(Date.now() - HIT_RETENTION_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    await pruneSiteHits(cutoff).catch((error: unknown) => {
      logger.warn(
        { err: errorMessage(error) },
        '[sites] could not prune request counts'
      );
    });
  }
}

/**
 * Count one served page. Only HTML pages, only GETs from something that looks
 * like a browser; assets (css, images, scripts) are not views.
 */
export function recordSiteView({
  filePath,
  pathname,
  request,
  site,
}: {
  filePath: string;
  pathname: string;
  request: Request;
  site: string;
}): void {
  if (request.method !== 'GET' || !filePath.endsWith('.html')) {
    return;
  }
  if (NOT_A_PERSON.test(request.headers.get('user-agent') ?? 'bot')) {
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const page = pathname.slice(site.length + 1).replace(/\/+$/, '') || '/';
  const key = `${site}\n${day}\n${page}`;
  pending.set(key, (pending.get(key) ?? 0) + 1);
}

export async function flushSiteViews(): Promise<void> {
  await flushSiteHits();
  if (pending.size === 0) {
    return;
  }
  const rows = [...pending].map(([key, views]) => {
    const [site = '', day = '', path = '/'] = key.split('\n');
    return { day, path, site, views };
  });
  pending.clear();
  await addSiteViews(rows).catch((error: unknown) => {
    logger.warn(
      { err: errorMessage(error), rows: rows.length },
      '[sites] could not save view counts'
    );
  });
}

export function startSiteAnalytics(): void {
  setInterval(() => {
    flushSiteViews().catch(() => undefined);
  }, FLUSH_MS);
}
