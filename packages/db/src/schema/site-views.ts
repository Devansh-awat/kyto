import { date, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

// Page views of hosted sites (lib/sites/analytics), per site, UTC day and page
// path. Counts only — no IP, no visitor id: a site is somebody's school project
// or a one-off page, and a view count is all the `sites` stats action shows.
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
