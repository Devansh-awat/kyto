import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../client';
import { type SiteView, siteViews } from '../schema';

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
}
