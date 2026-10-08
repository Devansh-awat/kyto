import { date, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

// Page views of hosted sites (lib/sites/analytics), per site, UTC day and page
// path. Counts only — no IP, no visitor id: a site is somebody's school project
// or a one-off page, and a view count is all its creator sees. Per-IP request
// counts live apart, in site_hits, for the owner only.
export const siteViews = pgTable(
  'site_views',
  {
    site: text('site').notNull(),
    day: date('day').notNull(),
    path: text('path').notNull(),
    views: integer('views').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.site, table.day, table.path] })]
);

export type SiteView = typeof siteViews.$inferSelect;

// Requests per client IP, per site and UTC day: INTERNAL (owner-only), for
// telling a DoS or a scraper from real traffic. Every request counts here —
// assets and bots too — unlike site_views. Kept 14 days (lib/sites/analytics).
export const siteHits = pgTable(
  'site_hits',
  {
    day: date('day').notNull(),
    ip: text('ip').notNull(),
    site: text('site').notNull(),
    requests: integer('requests').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.day, table.ip, table.site] })]
);
