import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';
import { deploySiteFromSandbox, removeSite } from '@/lib/sites/deploy';
import { isValidPagePath, isValidSiteName, siteUrl } from '@/lib/sites/paths';
import { errorMessage } from '@/lib/utils/error';

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

export function deploySiteTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      'Publish a prebuilt static site so it is reachable at https://<host>/<name>/. Build and test the site in the sandbox first, then point sourceDir at the built static output (e.g. dist or out). The host only serves static files — it never runs site code — so deploy fully static output (HTML/CSS/JS/assets), not a dev server. A site can have multiple pages: pass `page` to publish into a sub-path like /<name>/home without disturbing the rest of the site, or omit it to publish the whole site at the root.',
    inputSchema: z.object({
      name: siteNameSchema,
      page: pageSchema,
      sourceDir: z
        .string()
        .min(1)
        .describe(
          'Absolute path in the sandbox to the built static output directory, e.g. /home/user/project/dist.'
        ),
    }),
    execute: async ({ name, page, sourceDir }) => {
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

        const target = page ? `"${name}/${page}"` : `"${name}"`;
        return {
          success: true,
          summary: `Published ${target} (${result.fileCount} files) at ${siteUrl(name, page)}`,
          url: siteUrl(name, page),
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[deploySite] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function removeSiteTool() {
  return tool({
    description:
      'Take down a previously published static site so it is no longer served at /<name>/. Pass `page` to remove only a single page sub-path (e.g. "home") and leave the rest of the site up. Permanent — only use when explicitly asked.',
    inputSchema: z.object({ name: siteNameSchema, page: pageSchema }),
    execute: async ({ name, page }) => {
      try {
        if (!isValidSiteName(name)) {
          return { error: 'Invalid site name.', success: false };
        }
        if (page && !isValidPagePath(page)) {
          return { error: 'Invalid page path.', success: false };
        }
        await removeSite(name, page);
        const target = page ? `page "${name}/${page}"` : `site "${name}"`;
        return { success: true, summary: `Removed ${target}.` };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[removeSite] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
