import { addSiteViews } from '@repo/db/queries';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const FLUSH_MS = 60 * 1000;
// Link unfurlers and crawlers fetch a page the moment it's posted; counting
// them would make every site look visited once per share.
const NOT_A_PERSON =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python-requests|headless/i;

// Counted in memory and written once a minute: a page view must never wait on
// Postgres. A restart loses at most the last minute's counts.
const pending = new Map<string, number>();

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
