import { z } from 'zod';

// Which repos a GraphQL request WRITES to, for the proxy's write gate. Kept
// free of env and network (the node lookup is passed in) so it is testable on
// its own — it is the part of the gate an attacker shapes input for.

export interface GraphqlTarget {
  creates: string[];
  repos: string[];
  understood: boolean;
  write: boolean;
}

// `repository(owner: "o", name: "n")` and the `{owner, name}` / `{repo}` shapes
// GitHub's own GraphQL callers use. Anything else is refused rather than guessed.
const GRAPHQL_REPOSITORY =
  /repository\s*\(\s*owner\s*:\s*"([\w.-]+)"\s*,\s*name\s*:\s*"([\w.-]+)"/g;

// A GitHub GraphQL global node id, as it appears in a mutation's input
// (`repositoryId`, `pullRequestId`, `subjectId`, …). Opaque by design, so the
// only way to learn which repo one belongs to is to ask GitHub — see resolveNodes.
const NODE_ID = /^[A-Za-z0-9+/_=-]{8,}$/;
// The same, recognised by SHAPE rather than by the key it sits under: modern
// cspell:disable-next-line
// ids (`PR_kwDOAbc…`, `R_kgDO…`) and legacy base64 ones (`MDExOlB1bGxSZXF1ZXN0…`,
// which decode to `011:PullRequest123`). Needed because an id can sit under any
// key (`labelIds`, `nodeIds`) or inline in the query text.
const MODERN_NODE_ID = /^[A-Z][A-Za-z]{0,7}_k[A-Za-z][A-Za-z0-9_-]{6,}$/;
const LEGACY_NODE_ID = /^\d{2,3}:[A-Za-z]+\d/;

export function looksLikeNodeId(value: string): boolean {
  if (MODERN_NODE_ID.test(value)) {
    return true;
  }
  if (!/^[A-Za-z0-9+/]{12,}={0,2}$/.test(value)) {
    return false;
  }
  return LEGACY_NODE_ID.test(Buffer.from(value, 'base64').toString('latin1'));
}

// Node types a mutation may name WITHOUT a repo — the people it assigns or
// requests a review from. Any other id that resolves to no repo refuses the
// write: the guard can't check what it can't place.
const ACTOR_TYPES = new Set([
  'Bot',
  'Mannequin',
  'Organization',
  'Team',
  'User',
]);

export interface NodeInfo {
  repo?: string;
  type?: string;
}

/** Every plausible node id anywhere in a mutation's variables. */
function collectNodeIds(value: unknown, into: Set<string>, key = ''): void {
  if (typeof value === 'string') {
    // A git object id (`expectedHeadOid`) and the caller's own correlation id
    // end in "id" too, but are not nodes — resolving them would refuse a merge.
    const notANode = /oid$/i.test(key) || key === 'clientMutationId';
    if (
      !notANode &&
      ((/ids?$/i.test(key) && NODE_ID.test(value)) || looksLikeNodeId(value))
    ) {
      into.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNodeIds(item, into, key);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectNodeIds(child, into, childKey);
    }
  }
}

/** `owner/name` strings under a `…nameWithOwner` key (createCommitOnBranch). */
function collectNamesWithOwner(
  value: unknown,
  into: Set<string>,
  key = ''
): void {
  if (typeof value === 'string') {
    if (/nameWithOwner$/i.test(key)) {
      into.add(value);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectNamesWithOwner(child, into, childKey);
    }
  }
}

const REPO_PART = /^[\w.-]+$/;
const QUERY_STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;
const QUERY_NAME_WITH_OWNER = /nameWithOwner\s*:\s*"([^"]*)"/gi;

export async function graphqlTarget({
  body,
  resolveNodes,
}: {
  body: string | undefined;
  /** Which repo (or actor type) each node id belongs to — asks GitHub. */
  resolveNodes: (ids: string[]) => Promise<Map<string, NodeInfo>>;
}): Promise<GraphqlTarget> {
  const refused = { creates: [], repos: [], understood: false, write: true };
  let query = '';
  let variables: Record<string, unknown> = {};
  try {
    const parsed = z
      .object({
        query: z.string().optional(),
        variables: z.record(z.string(), z.unknown()).nullish(),
      })
      .parse(JSON.parse(body ?? '{}'));
    query = parsed.query ?? '';
    variables = parsed.variables ?? {};
  } catch {
    return refused;
  }
  const write = /(^|\W)mutation(\W|$)/.test(query);
  if (!write) {
    return { creates: [], repos: [], understood: true, write: false };
  }
  const repos = new Set<string>();
  for (const match of query.matchAll(GRAPHQL_REPOSITORY)) {
    if (match[1] && match[2]) {
      repos.add(`${match[1]}/${match[2]}`.toLowerCase());
    }
  }
  // `{owner, name}` variables count only when the query actually USES them —
  // otherwise they are a decoy: name an allowed repo in the variables, aim the
  // mutation at another one by id, and the guard checked the wrong repo.
  const ownerKey = ['owner', 'repositoryOwner'].find((key) =>
    query.includes(`$${key}`)
  );
  const nameKey = ['name', 'repo', 'repositoryName'].find((key) =>
    query.includes(`$${key}`)
  );
  const owner = ownerKey ? variables[ownerKey] : undefined;
  const name = nameKey ? variables[nameKey] : undefined;
  if (typeof owner === 'string' && typeof name === 'string') {
    repos.add(`${owner}/${name}`.toLowerCase());
  }
  const named = new Set<string>();
  collectNamesWithOwner(variables, named);
  for (const match of query.matchAll(QUERY_NAME_WITH_OWNER)) {
    named.add(match[1] ?? '');
  }
  for (const repo of named) {
    repos.add(repo.toLowerCase());
  }
  // A repo part that isn't a plain name (`a/../../x`) is spliced into URLs
  // later (collaborator checks), so it refuses the write outright.
  if (
    [...repos].some((repo) => {
      const parts = repo.split('/');
      return parts.length !== 2 || !parts.every((part) => REPO_PART.test(part));
    })
  ) {
    return refused;
  }
  const nodeIds = new Set<string>();
  collectNodeIds(variables, nodeIds);
  for (const match of query.matchAll(QUERY_STRING_LITERAL)) {
    const literal = match[1] ?? '';
    if (looksLikeNodeId(literal)) {
      nodeIds.add(literal);
    }
  }
  if (nodeIds.size > 0) {
    for (const info of (await resolveNodes([...nodeIds])).values()) {
      if (info.repo) {
        repos.add(info.repo);
      } else if (!(info.type && ACTOR_TYPES.has(info.type))) {
        return refused;
      }
    }
  }
  return {
    creates: [],
    repos: [...repos],
    understood: repos.size > 0,
    write: true,
  };
}
