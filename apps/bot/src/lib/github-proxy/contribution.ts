import { z } from 'zod';

// Which proxied writes are a CONTRIBUTION — a PR, an issue or a comment on a
// repo — the only third-party writes someone the owner never trusted may have
// kyto make. Pure (no env, no network) because it is the part an attacker
// shapes input for: whatever it says is the body is what gets reviewed and
// signed, so it must be the body GitHub will actually use.

export type ContributionKind = 'comment' | 'issue' | 'pr';

export interface Contribution {
  /** PR only: the branch it merges into. */
  baseRef?: string;
  /** PR only: the branch it comes from, as `owner:branch` or bare `branch`. */
  headRef?: string;
  /** GraphQL PR only: the node id of the repo the head branch lives in. */
  headRepositoryId?: string;
  kind: ContributionKind;
  /** REST comment only: the issue/PR it is on. */
  number?: number;
  /** REST: the target repo, lowercased `owner/name`. */
  repo?: string;
  /** GraphQL: the node id naming the target (a repo, or the issue/PR commented on). */
  subjectId?: string;
  text: string;
  title?: string;
  /** The request body to send instead, with `text` swapped for `next`. */
  withText: (next: string) => string;
}

const REST_PREFIX = '/api/v3/';
const REST_PATH =
  /^repos\/([\w.-]+)\/([\w.-]+)\/(pulls|issues|issues\/(\d+)\/comments)$/;

const restBody = z.looseObject({
  base: z.string().optional(),
  body: z.string().nullish(),
  head: z.string().optional(),
  title: z.string().optional(),
});

function restContribution({
  body,
  rest,
}: {
  body: string;
  rest: string;
}): Contribution | null {
  const match = REST_PATH.exec(rest.split('?')[0] ?? '');
  const [, owner, name, what, number] = match ?? [];
  if (!(owner && name && what)) {
    return null;
  }
  let json: z.infer<typeof restBody>;
  try {
    json = restBody.parse(JSON.parse(body));
  } catch {
    return null;
  }
  const kinds: Record<string, ContributionKind> = {
    issues: 'issue',
    pulls: 'pr',
  };
  const kind = kinds[what] ?? 'comment';
  return {
    baseRef: kind === 'pr' ? json.base : undefined,
    headRef: kind === 'pr' ? json.head : undefined,
    kind,
    number: number ? Number(number) : undefined,
    repo: `${owner}/${name}`.toLowerCase(),
    text: json.body ?? '',
    title: kind === 'comment' ? undefined : json.title,
    withText: (next) => JSON.stringify({ ...json, body: next }),
  };
}

const MUTATIONS: Record<string, ContributionKind> = {
  addComment: 'comment',
  createIssue: 'issue',
  createPullRequest: 'pr',
};

const graphqlBody = z.object({
  operationName: z.string().nullish(),
  query: z.string(),
  variables: z.looseObject({
    input: z.looseObject({
      baseRefName: z.string().optional(),
      body: z.string().nullish(),
      headRefName: z.string().optional(),
      headRepositoryId: z.string().optional(),
      repositoryId: z.string().optional(),
      subjectId: z.string().optional(),
      title: z.string().optional(),
    }),
  }),
});

/** The query with string literals and comments blanked out. */
function stripLiterals(query: string): string {
  return query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, '');
}

/**
 * The single top-level field of the document's single operation, and its
 * argument text — or null for anything else. A second operation, a second
 * field, a fragment spread or a directive is refused: each is a way to run a
 * mutation the review never looked at next to one it did.
 */
function soleField(query: string): { args: string; name: string } | null {
  const text = stripLiterals(query);
  if (/\bfragment\b/.test(text) || text.includes('...') || text.includes('@')) {
    return null;
  }
  let braces = 0;
  let parens = 0;
  let blocks = 0;
  const top: string[] = [];
  let args = '';
  let argsOwner = -1;
  for (const token of text.matchAll(/[_A-Za-z][_0-9A-Za-z]*|\S/g)) {
    const value = token[0];
    if (value === '{') {
      braces += 1;
      if (braces === 1 && parens === 0) {
        blocks += 1;
      }
      continue;
    }
    if (value === '}') {
      braces -= 1;
      continue;
    }
    if (value === '(') {
      parens += 1;
      if (braces === 1 && parens === 1) {
        argsOwner = top.length - 1;
        continue;
      }
    } else if (value === ')') {
      parens -= 1;
      if (braces === 1 && parens === 0) {
        continue;
      }
    }
    if (braces === 1 && parens >= 1 && argsOwner === top.length - 1) {
      args += value;
      continue;
    }
    if (braces === 1 && parens === 0) {
      top.push(value);
    }
  }
  if (blocks !== 1 || braces !== 0 || parens !== 0) {
    return null;
  }
  // `alias: field` or `field`, and nothing else at the top level.
  const name = top.length === 3 && top[1] === ':' ? top[2] : top[0];
  if (!name || (top.length !== 1 && top.length !== 3)) {
    return null;
  }
  return { args, name };
}

function graphqlContribution(body: string): Contribution | null {
  let parsed: z.infer<typeof graphqlBody>;
  try {
    parsed = graphqlBody.parse(JSON.parse(body));
  } catch {
    return null;
  }
  const field = soleField(parsed.query);
  const kind = field ? MUTATIONS[field.name] : undefined;
  // The input must come from `$input`, never inline: an inline input is a
  // second body next to the one in the variables, and the review would read
  // the decoy while GitHub used the other.
  if (!(field && kind) || field.args !== 'input:$input') {
    return null;
  }
  const { input } = parsed.variables;
  const subjectId = kind === 'comment' ? input.subjectId : input.repositoryId;
  if (!subjectId) {
    return null;
  }
  return {
    baseRef: kind === 'pr' ? input.baseRefName : undefined,
    headRef: kind === 'pr' ? input.headRefName : undefined,
    headRepositoryId: kind === 'pr' ? input.headRepositoryId : undefined,
    kind,
    subjectId,
    text: input.body ?? '',
    title: kind === 'comment' ? undefined : input.title,
    withText: (next) =>
      JSON.stringify({
        ...parsed,
        variables: { ...parsed.variables, input: { ...input, body: next } },
      }),
  };
}

/** A PR, issue or comment, or null when the write is anything else. */
export function classifyContribution({
  body,
  method,
  pathname,
}: {
  body: string | undefined;
  method: string;
  pathname: string;
}): Contribution | null {
  if (method !== 'POST' || !body) {
    return null;
  }
  if (pathname === '/api/graphql') {
    return graphqlContribution(body);
  }
  if (pathname.startsWith(REST_PREFIX)) {
    return restContribution({ body, rest: pathname.slice(REST_PREFIX.length) });
  }
  return null;
}
