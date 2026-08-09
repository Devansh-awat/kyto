import nodePath from 'node:path';
import { env } from '@/env';

/**
 * Static-site hosting paths and validation.
 *
 * Security model: the host NEVER executes site code. It only serves prebuilt
 * static files from SITES_ROOT/<name>/. The two attack surfaces we guard are
 * (1) the site name and (2) any path resolved beneath a site root — both must
 * be proven to stay inside their intended directory before any fs access.
 */

// Where kyto's own embeddable pages live (lib/embeds). Reserved so `deploySite`
// can never take the name and replace the lot: a whole-site deploy swaps the
// directory, which would delete every live embed in the workspace.
export const EMBED_SITE_NAME = 'embeds';

// Reserved directory names used internally under SITES_ROOT; never a site.
export const RESERVED_SITE_NAMES = new Set([
  '.tls',
  '.staging',
  EMBED_SITE_NAME,
]);

// Lowercase DNS-label style: 1–63 chars, alphanumeric, internal hyphens only.
const SITE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A name the router may serve. Shape only, plus the internal directories —
 * `embeds` IS served (that is the point of it), it just cannot be deployed to.
 */
export function isServableSiteName(name: string): boolean {
  return SITE_NAME_RE.test(name) && !name.startsWith('.');
}

/** A name a user may deploy to: servable, and not one of kyto's own. */
export function isValidSiteName(name: string): boolean {
  return isServableSiteName(name) && !RESERVED_SITE_NAMES.has(name);
}

/**
 * A page sub-path within a site, e.g. `home` or `docs/getting-started`. One or
 * more slug segments, each a DNS-label-style slug, joined by `/`. The router
 * then serves it at `/<site>/<page>/`. resolveWithin still enforces containment;
 * this is the additional shape check so page paths stay clean URL slugs.
 */
export function isValidPagePath(page: string): boolean {
  const segments = page.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  return segments.every((segment) => SITE_NAME_RE.test(segment));
}

export function sitesRoot(): string {
  return nodePath.resolve(env.SITES_ROOT);
}

/** Absolute directory that holds a single site's files. */
export function siteRoot(name: string): string {
  if (!isValidSiteName(name)) {
    throw new Error(`Invalid site name: ${name}`);
  }
  return nodePath.join(sitesRoot(), name);
}

/**
 * Resolve `relative` beneath `root`, returning the absolute path only if it
 * stays within `root`. Returns null on any traversal attempt (`..`, absolute
 * paths, encoded separators that normalize outside the root, NUL bytes).
 */
export function resolveWithin(root: string, relative: string): string | null {
  if (relative.includes('\0')) {
    return null;
  }
  const resolvedRoot = nodePath.resolve(root);
  const target = nodePath.resolve(resolvedRoot, `.${nodePath.sep}${relative}`);
  if (
    target !== resolvedRoot &&
    !target.startsWith(resolvedRoot + nodePath.sep)
  ) {
    return null;
  }
  return target;
}

/** Public URL for a deployed site (optionally a page within it). */
export function siteUrl(name: string, page?: string): string {
  const host = env.SITES_PUBLIC_HOST ?? 'localhost';
  const suffix = page ? `${page}/` : '';
  return `https://${host}/${name}/${suffix}`;
}
