import { stat } from 'node:fs/promises';
import type { SandboxContext } from '@repo/ai';
import {
  claimSite,
  deleteSite,
  deleteSiteViews,
  getSite,
  listSiteViews,
  setSiteEditors,
} from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';
import {
  deploySiteFromSandbox,
  listSites,
  removeSite,
} from '@/lib/sites/deploy';
import {
  isValidPagePath,
  isValidSiteName,
  siteRoot,
  siteUrl,
} from '@/lib/sites/paths';
import { errorMessage } from '@/lib/utils/error';
import { canEdit, editorsSchema, parseEditors } from './editors';

const siteNameSchema = z
  .string()
  .min(1)
  .max(63)
  .describe(
    'Site name used in the URL path /<name>/. Lowercase letters, digits, and hyphens only.'
  );

const pageSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Optional page sub-path within the site, e.g. "home" or "docs/intro", served at /<name>/<page>/. Lowercase slug segments separated by "/". Deploying a page only swaps that sub-path and leaves the rest of the site intact, so a multi-page site can be published one page at a time. Omit to publish/replace the whole site at /<name>/.'
  );

type SiteAccess =
  | { allowed: true; claimed: boolean }
  | { allowed: false; reason: string };

async function siteExistsOnDisk(name: string): Promise<boolean> {
  try {
    const entry = await stat(siteRoot(name));
    return entry.isDirectory();
  } catch {
    return false;
  }
}

/**
 * A site name is claimed by whoever first publishes it. After that, only its
 * creator, the editors they named, and the bot owner may republish, re-share, or
 * take it down — so a passer-by can't overwrite or delete someone else's site.
 *
 * Sites published before ownership was recorded have no row. They are already
 * live on disk, so they are treated as owned by nobody-but-the-bot-owner rather
 * than left free for the next person to claim.
 */
async function checkSiteAccess({
  isOwner,
  name,
  userId,
}: {
  isOwner: boolean;
  name: string;
  userId: string;
}): Promise<SiteAccess> {
  const site = await getSite(name);
  if (site) {
    const allowed = canEdit({
      editorUserIds: site.editorUserIds,
      isOwner,
      ownerUserId: site.ownerUserId,
      userId,
    });
    return allowed
      ? { allowed: true, claimed: true }
      : {
          allowed: false,
          reason: `The site "${name}" belongs to <@${site.ownerUserId}>. Only its creator, the editors they named, and the bot owner can change it.`,
        };
  }
  if (await siteExistsOnDisk(name)) {
    return isOwner
      ? { allowed: true, claimed: false }
      : {
          allowed: false,
          reason: `The site "${name}" already exists and has no recorded creator (it predates site ownership), so only the bot owner can change it. Pick a different name.`,
        };
  }
  return { allowed: true, claimed: false };
}

export function deploySiteTool({
  getSandboxContext,
  isOwner,
  userId,
}: {
  getSandboxContext: () => SandboxContext | undefined;
  isOwner: boolean;
  userId: string;
}) {
  return tool({
    description:
      'Publish a prebuilt static site so it is reachable at https://<host>/<name>/. Build and test the site in the sandbox first, then point sourceDir at the built static output (e.g. dist or out). The host only serves static files — it never runs site code — so deploy fully static output (HTML/CSS/JS/assets), not a dev server. A site can have multiple pages: pass `page` to publish into a sub-path like /<name>/home without disturbing the rest of the site, or omit it to publish the whole site at the root. Publishing a new name claims it for the person who asked; re-publishing an existing name edits that site, which only its creator, the editors they named, and the bot owner may do.',
    inputSchema: z.object({
      editors: editorsSchema,
      name: siteNameSchema,
      page: pageSchema,
      sourceDir: z
        .string()
        .min(1)
        .describe(
          'Absolute path in the sandbox to the built static output directory, e.g. /home/user/project/dist.'
        ),
    }),
    execute: async ({ editors, name, page, sourceDir }) => {
      try {
        if (!isValidSiteName(name)) {
          return {
            error:
              'Invalid site name. Use 1–63 lowercase letters, digits, or hyphens (no leading/trailing hyphen).',
            success: false,
          };
        }
        if (page && !isValidPagePath(page)) {
          return {
            error:
              'Invalid page path. Use lowercase slug segments separated by "/", e.g. "home" or "docs/intro".',
            success: false,
          };
        }
        const parsedEditors = parseEditors(editors);
        if (!parsedEditors.ok) {
          return { error: parsedEditors.error, success: false };
        }
        const access = await checkSiteAccess({ isOwner, name, userId });
        if (!access.allowed) {
          return { error: access.reason, success: false };
        }
        const context = getSandboxContext();
        if (!context) {
          return {
            error: 'No active sandbox session is available to deploy from.',
            success: false,
          };
        }

        const result = await deploySiteFromSandbox({
          name,
          page,
          session: context.session,
          sourceDir,
        });
        if (!result.ok) {
          return { error: result.error, success: false };
        }

        if (access.claimed) {
          if (editors) {
            await setSiteEditors({
              editorUserIds: parsedEditors.editors,
              name,
            });
          }
        } else {
          await claimSite({
            editorUserIds: parsedEditors.editors,
            name,
            ownerUserId: userId,
          });
        }

        const target = page ? `"${name}/${page}"` : `"${name}"`;
        const shared = parsedEditors.editors
          ? ` Editable by ${parsedEditors.editors.map((id) => `<@${id}>`).join(', ')}.`
          : '';
        return {
          success: true,
          summary: `Published ${target} (${result.fileCount} files) at ${siteUrl(name, page)}.${shared}`,
          url: siteUrl(name, page),
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[deploySite] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function listSitesTool() {
  return tool({
    description:
      'List the static sites currently published on the host (name and live URL).',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const sites = await listSites();
        return {
          count: sites.length,
          sites,
          success: true,
          summary: sites.length
            ? `${sites.length} site(s) published.`
            : 'No sites are currently published.',
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function removeSiteTool({
  isOwner,
  userId,
}: {
  isOwner: boolean;
  userId: string;
}) {
  return tool({
    description:
      'Take down a published static site so it is no longer served at /<name>/. Pass `page` to remove only a single page sub-path (e.g. "home") and leave the rest of the site up. Permanent — only use when explicitly asked. Only the site\'s creator, the editors they named, and the bot owner may remove it.',
    inputSchema: z.object({ name: siteNameSchema, page: pageSchema }),
    execute: async ({ name, page }) => {
      try {
        if (!isValidSiteName(name)) {
          return { error: 'Invalid site name.', success: false };
        }
        if (page && !isValidPagePath(page)) {
          return { error: 'Invalid page path.', success: false };
        }
        const access = await checkSiteAccess({ isOwner, name, userId });
        if (!access.allowed) {
          return { error: access.reason, success: false };
        }
        await removeSite(name, page);
        // Removing the whole site releases the name (and its view counts);
        // removing one page does not.
        if (!page) {
          await deleteSite(name);
          await deleteSiteViews(name).catch(() => undefined);
        }
        const target = page ? `page "${name}/${page}"` : `site "${name}"`;
        return { success: true, summary: `Removed ${target}.` };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[removeSite] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

const STATS_DAYS_DEFAULT = 30;
const STATS_DAYS_MAX = 365;
const TOP_PAGES = 10;

/**
 * How many people looked at a hosted site: views per day and the most-viewed
 * pages (lib/sites/analytics counts HTML page loads from browsers, not bots or
 * link previews). Same people as editing it: its creator, the editors they
 * named, and the owner.
 */
export function siteStatsTool({
  isOwner,
  userId,
}: {
  isOwner: boolean;
  userId: string;
}) {
  return tool({
    description:
      "View counts for a published site: total, per day, and its most-viewed pages, over the last N days (default 30). Counts page loads from browsers (not bots or link previews); there is no visitor tracking. Only the site's creator, its editors and the bot owner may see them. Counts started on 2026-10-08.",
    inputSchema: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(STATS_DAYS_MAX)
        .optional()
        .describe('How many days back, default 30.'),
      name: siteNameSchema,
    }),
    execute: async ({ days = STATS_DAYS_DEFAULT, name }) => {
      try {
        if (!isValidSiteName(name)) {
          return { error: 'Invalid site name.', success: false };
        }
        const access = await checkSiteAccess({ isOwner, name, userId });
        if (!access.allowed) {
          return { error: access.reason, success: false };
        }
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const rows = await listSiteViews({ since, site: name });
        const byDay = new Map<string, number>();
        const byPage = new Map<string, number>();
        for (const row of rows) {
          byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.views);
          byPage.set(row.path, (byPage.get(row.path) ?? 0) + row.views);
        }
        const total = [...byDay.values()].reduce((sum, n) => sum + n, 0);
        return {
          perDay: [...byDay]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, views]) => ({ day, views })),
          since,
          success: true,
          topPages: [...byPage]
            .sort(([, a], [, b]) => b - a)
            .slice(0, TOP_PAGES)
            .map(([path, views]) => ({ path, views })),
          totalViews: total,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[siteStats] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
