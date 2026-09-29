import { readdirSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import {
  deleteSkill,
  listStoredSkills,
  type StoredSkill,
  saveSkill,
} from '@repo/db/queries';
import { z } from 'zod';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { githubSkillSource, type ParsedSkill, parseSkill } from './parse';

// Skills: named instructions kyto loads when a task matches (owner's ask,
// 2026-09-29, after coolton's). The index — name and description of each — is
// in the `loadSkill` tool's description, and the body is fetched only when used.
//
// A skill is prompt text EVERY user's turn may load, so writing one is
// owner-only (same reasoning as a promoted memory: one stored instruction could
// steer kyto for everyone). Built-ins ship in the repo; the owner's rows in
// `skills` add to them or replace one by name.

export interface Skill extends ParsedSkill {
  builtin: boolean;
  files: Record<string, string>;
  source?: string;
}

// Every .md in apps/bot/src/skills. Read once at load; a file that does not
// parse fails the boot, since it can only be a mistake in this repo.
const BUILTIN_DIR = nodePath.join(import.meta.dir, '../../skills');
const BUILTINS: Skill[] = readdirSync(BUILTIN_DIR)
  .filter((file) => file.endsWith('.md'))
  .map((file) => {
    const parsed = parseSkill(
      readFileSync(nodePath.join(BUILTIN_DIR, file), 'utf8')
    );
    if (!parsed.ok) {
      throw new Error(`built-in skill ${file} does not parse: ${parsed.error}`);
    }
    return { ...parsed.skill, builtin: true, files: {} };
  });

// Held for a minute: it is read on every turn to build the tool description.
const CACHE_MS = 60_000;
let cache: { at: number; skills: Promise<Skill[]> } | undefined;

function fromRow(row: StoredSkill): Skill {
  return {
    body: row.body,
    builtin: false,
    description: row.description,
    files: row.files,
    name: row.name,
    ...(row.source ? { source: row.source } : {}),
  };
}

/** Every skill, sorted by name — the order is part of a cached prompt prefix. */
export function listSkills(): Promise<Skill[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.skills;
  }
  const skills = listStoredSkills()
    .then((rows) => {
      const byName = new Map(BUILTINS.map((skill) => [skill.name, skill]));
      for (const row of rows) {
        byName.set(row.name, fromRow(row));
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    })
    .catch((error: unknown) => {
      logger.warn(toLogError(error), '[skills] could not load stored skills');
      cache = undefined;
      return [...BUILTINS];
    });
  cache = { at: Date.now(), skills };
  return skills;
}

export async function getSkill(name: string): Promise<Skill | undefined> {
  return (await listSkills()).find((skill) => skill.name === name);
}

export async function writeSkill({
  files = {},
  skill,
  source,
  userId,
}: {
  files?: Record<string, string>;
  skill: ParsedSkill;
  source?: string;
  userId: string;
}): Promise<void> {
  await saveSkill({
    ...skill,
    files,
    source: source ?? null,
    updatedBy: userId,
  });
  cache = undefined;
}

/** Removes the owner's row. A built-in of the same name comes back. */
export async function removeSkill(name: string): Promise<boolean> {
  const removed = await deleteSkill(name);
  cache = undefined;
  return removed;
}

const MAX_FILE_CHARS = 60_000;
const MAX_REFERENCE_FILES = 20;
const FETCH_TIMEOUT_MS = 15_000;

const contentsSchema = z.array(
  z.looseObject({ name: z.string(), path: z.string(), type: z.string() })
);

async function fetchText(url: string): Promise<string | undefined> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return;
  }
  const text = await response.text();
  return text.length > MAX_FILE_CHARS
    ? `${text.slice(0, MAX_FILE_CHARS)}\n…(truncated)`
    : text;
}

/**
 * Fetch a skill from a public GitHub folder: its SKILL.md plus any markdown in
 * `references/`. Anonymous (no kyto credential goes near a third-party URL).
 * Returns what was found; saving it is the caller's call.
 */
export async function fetchGithubSkill(url: string): Promise<
  | {
      files: Record<string, string>;
      ok: true;
      skill: ParsedSkill;
      source: string;
    }
  | { error: string; ok: false }
> {
  const where = githubSkillSource(url);
  if (!where) {
    return {
      error:
        'Give a GitHub link to a skill folder or its SKILL.md (github.com/…/tree/… or …/blob/…/SKILL.md).',
      ok: false,
    };
  }
  const base = `https://raw.githubusercontent.com/${where.owner}/${where.repo}/${where.ref}${where.dir ? `/${where.dir}` : ''}`;
  const markdown = await fetchText(`${base}/SKILL.md`);
  if (!markdown) {
    return { error: `No SKILL.md at ${base}/SKILL.md.`, ok: false };
  }
  const parsed = parseSkill(markdown);
  if (!parsed.ok) {
    return {
      error: `That SKILL.md does not parse: ${parsed.error}`,
      ok: false,
    };
  }
  const files: Record<string, string> = {};
  const listing = await fetch(
    `https://api.github.com/repos/${where.owner}/${where.repo}/contents/${where.dir ? `${where.dir}/` : ''}references?ref=${where.ref}`,
    {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  ).catch(() => undefined);
  const entries = listing?.ok
    ? contentsSchema.safeParse(await listing.json())
    : undefined;
  for (const entry of (entries?.success ? entries.data : [])
    .filter((item) => item.type === 'file' && item.name.endsWith('.md'))
    .slice(0, MAX_REFERENCE_FILES)) {
    const text = await fetchText(`${base}/references/${entry.name}`);
    if (text) {
      files[`references/${entry.name}`] = text;
    }
  }
  return {
    files,
    ok: true,
    skill: parsed.skill,
    source: `https://github.com/${where.owner}/${where.repo}/tree/${where.ref}/${where.dir}`,
  };
}
