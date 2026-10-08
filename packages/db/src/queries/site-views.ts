import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../client';
import { type SiteView, siteHits, siteViews } from '../schema';

export type { SiteView } from '../schema';

/** Add a batch of counted views (one row per site/day/path). */
export async function addSiteViews(
  rows: { day: string; path: string; site: string; views: number }[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db
    .insert(siteViews)
    .values(rows)
    .onConflictDoUpdate({
      set: { views: sql`${siteViews.views} + excluded.views` },
      target: [siteViews.site, siteViews.day, siteViews.path],
    });
}

export function listSiteViews({
  since,
  site,
}: {
  since: string;
  site: string;
}): Promise<SiteView[]> {
  return db
    .select()
    .from(siteViews)
    .where(and(eq(siteViews.site, site), gte(siteViews.day, since)));
}

/** A site taken down takes its counts with it. */
export async function deleteSiteViews(site: string): Promise<void> {
  await db.delete(siteViews).where(eq(siteViews.site, site));
  await db.delete(siteHits).where(eq(siteHits.site, site));
}

export async function addSiteHits(
  rows: { day: string; ip: string; requests: number; site: string }[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db
    .insert(siteHits)
    .values(rows)
    .onConflictDoUpdate({
      set: { requests: sql`${siteHits.requests} + excluded.requests` },
      target: [siteHits.day, siteHits.ip, siteHits.site],
    });
}

/** The busiest client IPs for a site since `since`, most requests first. */
export async function topSiteHitIps({
  limit,
  since,
  site,
}: {
  limit: number;
  since: string;
  site: string;
}): Promise<{ ip: string; requests: number }[]> {
  return await db
    .select({
      ip: siteHits.ip,
      requests: sql<number>`sum(${siteHits.requests})::int`,
    })
    .from(siteHits)
    .where(and(eq(siteHits.site, site), gte(siteHits.day, since)))
    .groupBy(siteHits.ip)
    .orderBy(sql`sum(${siteHits.requests}) desc`)
    .limit(limit);
}

/** Drop IP counts older than `before` (they're kept 14 days). */
export async function pruneSiteHits(before: string): Promise<void> {
  await db.delete(siteHits).where(lt(siteHits.day, before));
}
