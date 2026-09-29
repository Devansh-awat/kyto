// Reading a SKILL.md: YAML-ish frontmatter with `name` and `description`, then
// the body. Only those two keys are read, and only as single-line scalars — the
// format every skill in the wild uses — so there is no YAML dependency to trust
// with third-party text.

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION = 600;

export interface ParsedSkill {
  body: string;
  description: string;
  name: string;
}

function scalar(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.at(-1) === quote) {
    const inner = value.slice(1, -1);
    return quote === "'" ? inner.replaceAll("''", "'") : inner;
  }
  return value;
}

/** The skill, or an error saying what is wrong with the file. */
export function parseSkill(
  markdown: string
): { ok: true; skill: ParsedSkill } | { error: string; ok: false } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(
    markdown.trimStart()
  );
  if (!match) {
    return { error: 'no frontmatter (--- name/description ---)', ok: false };
  }
  const [, head = '', body = ''] = match;
  const fields = new Map<string, string>();
  for (const line of head.split(/\r?\n/)) {
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (field?.[1]) {
      fields.set(field[1], scalar(field[2] ?? ''));
    }
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!SKILL_NAME.test(name)) {
    return {
      error: `name must be lowercase letters, digits and hyphens (got "${name}")`,
      ok: false,
    };
  }
  if (!description) {
    return { error: 'description is missing', ok: false };
  }
  return {
    ok: true,
    skill: {
      body: body.trim(),
      description: description.slice(0, MAX_DESCRIPTION),
      name,
    },
  };
}

/**
 * The raw SKILL.md URL and directory for a GitHub link to a skill: a `tree/`
 * folder, a `blob/` SKILL.md, or a raw.githubusercontent.com SKILL.md. Only
 * GitHub, over https — the owner installs by link, and a fixed host keeps this
 * from being a fetch-anything primitive.
 */
export function githubSkillSource(url: string):
  | {
      dir: string;
      owner: string;
      ref: string;
      repo: string;
    }
  | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.port) {
    return;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  let owner: string | undefined;
  let repo: string | undefined;
  let ref: string | undefined;
  let path: string[] = [];
  if (parsed.hostname === 'github.com') {
    const [o, r, kind, branch, ...rest] = parts;
    if (!(kind === 'tree' || kind === 'blob')) {
      return;
    }
    [owner, repo, ref, path] = [o, r, branch, rest];
  } else if (parsed.hostname === 'raw.githubusercontent.com') {
    const [o, r, branch, ...rest] = parts;
    [owner, repo, ref, path] = [o, r, branch, rest];
  } else {
    return;
  }
  if (path.at(-1) === 'SKILL.md') {
    path = path.slice(0, -1);
  }
  const safe = /^[\w.-]+$/;
  if (
    !(
      owner &&
      repo &&
      ref &&
      [owner, repo, ref, ...path].every(
        (part) => safe.test(part) && part !== '..'
      )
    )
  ) {
    return;
  }
  return { dir: path.join('/'), owner, ref, repo };
}
