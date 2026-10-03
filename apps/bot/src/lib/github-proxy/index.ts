import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { GITHUB_LOGIN, guardGithubTargets } from '@/lib/github/guard';
import { brokerableGithubToken } from '@/lib/github/token';
import { mayCarryPat } from '@/lib/github-proxy/host';
import logger from '@/lib/logger';

/**
 * A host-side GitHub proxy: the sandbox's `gh` and `git` talk to THIS, and the
 * real PAT never leaves the host.
 *
 * Why it exists (owner, 2026-07-29): "if you get a shell into kyto, you can use
 * its gh and do stuff right? … remote shells are not easy to stop, you block
 * sshx one will use tmate". He was right, and the token being unextractable did
 * not help. The old design brokered the PAT in an E2B egress rule, which stapled
 * `Authorization` onto EVERY github.com request out of the sandbox — so ANY
 * process in the box was already authenticated as `kyto-agent`, whether or not
 * it came through a kyto tool. `guardGithubCommand` only ever sees strings that
 * passed through a tool, so a shell script, sshx, tmate or `sh -c 'g''h …'`
 * never met the gate at all.
 *
 * The fix is not a bigger parser, it is moving the gate to where the bytes are:
 * nothing in the sandbox has GitHub credentials any more (a bare `curl
 * https://api.github.com` is anonymous — fine for public reads, useless for
 * writes), and every authenticated request is classified and guarded HERE, in
 * the same `guardGithubTargets` the shell tools use.
 *
 * Accepted trade (owner's decision, 2026-08-01): this bakes ONE principal per
 * proxy token rather than per shell command. That matches the sandbox, which is
 * already one thread's, i.e. one conversation's.
 *
 * Mounted on the sites Bun.serve beside the Slack proxy. It answers a request
 * ONLY when a valid per-turn token is present, and returns null otherwise — so a
 * hosted site called `api` (or a repo path that happens to look like a git
 * endpoint) is never shadowed by it.
 */

const PROXY_TOKEN_TTL_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 120_000;
/** How much of a JSON write body to buffer for repo extraction. */
const MAX_BUFFERED_BODY = 2 * 1024 * 1024;

// gh talks to a non-github.com host as if it were GitHub Enterprise Server.
const REST_PREFIX = '/api/v3/';
const GRAPHQL_PATH = '/api/graphql';
const UPLOADS_PREFIX = '/api/uploads/';
// git smart HTTP, which lands at the host root: `<owner>/<repo>.git/info/refs`.
const GIT_PATH =
  /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const GIT_SERVICE = /^git-(?:upload|receive)-pack$/;

interface Principal {
  expiry: number;
  isOwner: boolean;
  threadId?: string;
  userId?: string;
}

const tokens = new Map<string, Principal>();

/**
 * Mint a proxy token bound to the person whose turn (or reminder) this is.
 * Everything that token authenticates is guarded as THEM.
 */
export function registerGithubProxyToken({
  isOwner,
  threadId,
  userId,
}: {
  isOwner: boolean;
  threadId?: string;
  userId?: string;
}): string {
  const secret = randomBytes(24).toString('base64url');
  tokens.set(secret, {
    expiry: Date.now() + PROXY_TOKEN_TTL_MS,
    isOwner,
    threadId,
    userId,
  });
  return secret;
}

export function revokeGithubProxyToken(secret: string | undefined): void {
  if (secret) {
    tokens.delete(secret);
  }
}

function principalFor(secret: string | undefined): Principal | undefined {
  if (!secret) {
    return;
  }
  const principal = tokens.get(secret);
  if (!principal) {
    return;
  }
  if (Date.now() > principal.expiry) {
    tokens.delete(secret);
    return;
  }
  return principal;
}

/**
 * The secret out of whatever auth scheme the caller used: `gh` sends the token
 * as a bearer, git's credential helper sends it as the Basic password.
 */
function presentedSecret(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) {
    return;
  }
  const basic = /^Basic\s+(\S+)$/i.exec(header);
  if (basic?.[1]) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return password || undefined;
  }
  const bearer = /^(?:Bearer|token)\s+(\S+)$/i.exec(header);
  return bearer?.[1];
}

interface Target {
  /** Repos this request would CREATE, for the claim on success. */
  creates: string[];
  /** Repos this request touches, lowercased `owner/name`. */
  repos: string[];
  /** False when a write's target could not be determined at all. */
  understood: boolean;
  upstream: string;
  write: boolean;
}

function restTarget({
  body,
  method,
  rest,
}: {
  body: string | undefined;
  method: string;
  rest: string;
}): Omit<Target, 'upstream'> {
  const write = !READ_METHODS.has(method);
  const segments = rest.split('?')[0]?.split('/') ?? [];
  const [first, second, third] = segments;
  if (first === 'repos' && second && third) {
    return {
      creates: [],
      repos: [`${second}/${third}`],
      understood: true,
      write,
    };
  }
  // Repo creation: POST /user/repos (kyto's own namespace) or
  // POST /orgs/{org}/repos. The new repo's name is in the JSON body.
  const created = write ? newRepoName(body) : undefined;
  if (first === 'user' && second === 'repos' && created) {
    // Created under kyto's own account; the body carries only the bare name,
    // which the guard would otherwise read as an unknown third-party repo.
    const repo = `${GITHUB_LOGIN}/${created.split('/').at(-1)}`.toLowerCase();
    return { creates: [repo], repos: [repo], understood: true, write };
  }
  if (first === 'orgs' && second && third === 'repos' && created) {
    const repo = `${second}/${created.split('/').at(-1)}`;
    return { creates: [repo], repos: [repo], understood: true, write };
  }
  // A read that names no repo (search, /user, /rate_limit) is fine — reads are
  // open under both gates. A WRITE that names no repo is not: it could be
  // anything from a gist to a follow, and the guard has nothing to check it
  // against, so `understood: false` refuses it below.
  return { creates: [], repos: [], understood: !write, write };
}

function newRepoName(body: string | undefined): string | undefined {
  if (!body) {
    return;
  }
  try {
    const parsed = JSON.parse(body) as { name?: unknown; owner?: unknown };
    if (typeof parsed.name !== 'string' || !parsed.name) {
      return;
    }
    const owner = typeof parsed.owner === 'string' ? parsed.owner : undefined;
    return owner ? `${owner}/${parsed.name}` : parsed.name;
  } catch {
    return;
  }
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

interface NodeInfo {
  repo?: string;
  type?: string;
}
const nodeCache = new Map<string, NodeInfo>();
const NODE_CACHE_MAX = 500;

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

const NODE_QUERY = `query($ids:[ID!]!){nodes(ids:$ids){__typename
... on Repository{nameWithOwner}
... on PullRequest{repository{nameWithOwner}}
... on Issue{repository{nameWithOwner}}
... on Discussion{repository{nameWithOwner}}
... on Ref{repository{nameWithOwner}}
... on Release{repository{nameWithOwner}}
... on Label{repository{nameWithOwner}}
... on Milestone{repository{nameWithOwner}}
... on IssueComment{repository{nameWithOwner}}
... on PullRequestReview{repository{nameWithOwner}}
... on PullRequestReviewComment{repository{nameWithOwner}}
... on Commit{repository{nameWithOwner}}}}`;

const nodesResponseSchema = z.object({
  data: z
    .object({
      nodes: z
        .array(
          z
            .object({
              __typename: z.string().optional(),
              nameWithOwner: z.string().optional(),
              repository: z
                .object({ nameWithOwner: z.string().optional() })
                .nullish(),
            })
            .nullable()
        )
        .optional(),
    })
    .nullish(),
});

/**
 * Ask GitHub which repo each node id belongs to.
 *
 * This exists because `gh` does its WRITES over GraphQL with opaque ids —
 * `gh pr create` sends `createPullRequest(input:{repositoryId})` and never names
 * the repo — so without this every PR, merge and review kyto opens would be
 * refused as "does not name a repository". Resolved with kyto's own PAT (the
 * same credential the request would use anyway) and cached, since a node id
 * never changes what it points at. A failed lookup is not cached.
 */
async function resolveNodes(ids: string[]): Promise<Map<string, NodeInfo>> {
  const unknown = ids.filter((id) => !nodeCache.has(id));
  if (unknown.length > 0) {
    const token = await brokerableGithubToken();
    const resolved = token ? await askNodes(unknown, token) : undefined;
    if (nodeCache.size + unknown.length > NODE_CACHE_MAX) {
      nodeCache.clear();
    }
    for (const [id, info] of resolved ?? []) {
      nodeCache.set(id, info);
    }
  }
  return new Map(ids.map((id) => [id, nodeCache.get(id) ?? {}]));
}

async function askNodes(
  ids: string[],
  token: string
): Promise<Map<string, NodeInfo> | undefined> {
  try {
    const response = await fetch('https://api.github.com/graphql', {
      body: JSON.stringify({ query: NODE_QUERY, variables: { ids } }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = nodesResponseSchema.parse(await response.json());
    const nodes = parsed.data?.nodes ?? [];
    const found = new Map<string, NodeInfo>();
    for (const [index, id] of ids.entries()) {
      const node = nodes[index];
      found.set(id, {
        repo: (
          node?.nameWithOwner ?? node?.repository?.nameWithOwner
        )?.toLowerCase(),
        type: node?.__typename,
      });
    }
    return found;
  } catch (error) {
    // An unresolvable id leaves the mutation with a target the guard can't
    // place, which the caller treats as "not understood" and REFUSES. A GitHub
    // outage therefore blocks writes rather than waving them through.
    logger.warn({ err: error }, '[github-proxy] node id lookup failed');
    return;
  }
}

const REPO_PART = /^[\w.-]+$/;
const QUERY_STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;
const QUERY_NAME_WITH_OWNER = /nameWithOwner\s*:\s*"([^"]*)"/gi;

export async function graphqlTarget(
  body: string | undefined
): Promise<Omit<Target, 'upstream'>> {
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
    for (const [id, info] of await resolveNodes([...nodeIds])) {
      if (info.repo) {
        repos.add(info.repo);
      } else if (!(info.type && ACTOR_TYPES.has(info.type))) {
        logger.info(
          { id, type: info.type },
          '[github-proxy] unplaceable node id'
        );
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

function gitTarget({
  owner,
  repo,
  search,
  service,
}: {
  owner: string;
  repo: string;
  search: string;
  service: string;
}): Omit<Target, 'upstream'> {
  // A push is `git-receive-pack`, both when git advertises refs for it and when
  // it sends the pack. Everything else on this path is a fetch/clone, i.e. a
  // read, which stays open.
  const write =
    service === 'git-receive-pack' || search.includes('git-receive-pack');
  return { creates: [], repos: [`${owner}/${repo}`], understood: true, write };
}

/** Classify a proxied request: where it goes, and what it would change. */
async function classify({
  body,
  method,
  pathname,
  search,
}: {
  body: string | undefined;
  method: string;
  pathname: string;
  search: string;
}): Promise<Target | null> {
  if (pathname === GRAPHQL_PATH) {
    return {
      ...(await graphqlTarget(body)),
      upstream: 'https://api.github.com/graphql',
    };
  }
  if (pathname.startsWith(REST_PREFIX)) {
    const rest = pathname.slice(REST_PREFIX.length);
    return {
      ...restTarget({ body, method, rest }),
      upstream: `https://api.github.com/${rest}${search}`,
    };
  }
  if (pathname.startsWith(UPLOADS_PREFIX)) {
    const rest = pathname.slice(UPLOADS_PREFIX.length);
    // Release-asset uploads name their repo in the path exactly like the REST
    // API does, so the same extraction applies.
    return {
      ...restTarget({ body, method, rest }),
      upstream: `https://uploads.github.com/${rest}${search}`,
    };
  }
  const git = GIT_PATH.exec(pathname);
  const [, owner, repo, service] = git ?? [];
  if (owner && repo && service) {
    return {
      ...gitTarget({ owner, repo, search, service }),
      upstream: `https://github.com/${owner}/${repo}.git/${service}${search}`,
    };
  }
  return null;
}

/**
 * Is this unmistakably a git smart-HTTP request? Used only to decide whether an
 * UNAUTHENTICATED request deserves a 401 challenge instead of falling through to
 * static hosting, so it is deliberately narrow: the ref advertisement always
 * carries `?service=git-…-pack`, and the two POST endpoints always carry a
 * `application/x-git-…` content type.
 */
function looksLikeGit({
  pathname,
  request,
  search,
}: {
  pathname: string;
  request: Request;
  search: string;
}): boolean {
  const match = GIT_PATH.exec(pathname);
  const service = match?.[3];
  if (!service) {
    return false;
  }
  if (service === 'info/refs') {
    const wanted = new URLSearchParams(search).get('service') ?? '';
    return GIT_SERVICE.test(wanted);
  }
  return (request.headers.get('content-type') ?? '').startsWith(
    'application/x-git-'
  );
}

/** Headers to drop when forwarding: hop-by-hop, plus anything we re-set. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
]);

// Bun's fetch decompresses the upstream body, so passing these through would
// describe the bytes we send incorrectly and the client would fail to parse them.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'transfer-encoding',
]);

function refusal(reason: string, status: number): Response {
  // Shaped like GitHub's own error body so `gh` prints the message rather than
  // "unexpected response". The model reads this text, so it has to say what to
  // do next, not just "denied".
  return new Response(
    JSON.stringify({ documentation_url: '', message: reason }),
    {
      headers: { 'Content-Type': 'application/json' },
      status,
    }
  );
}

/**
 * Serve a GitHub proxy request, or return null when it is not one of ours.
 *
 * Null (rather than a 404) is deliberate: this is mounted on the PUBLIC sites
 * server, and returning null lets an ordinary visitor's request fall through to
 * static hosting untouched. A request only becomes ours when it carries a live
 * proxy token, so no hosted site path can be shadowed.
 */
export async function handleGithubProxy(
  request: Request,
  pathname: string
): Promise<Response | null> {
  const { search } = new URL(request.url);
  const principal = principalFor(presentedSecret(request));
  if (!principal) {
    // git does NOT send credentials until it is asked for them: a clone starts
    // with an anonymous `info/refs`, and without a challenge here it saw the
    // fall-through 404 and gave up ("repository not found") before the
    // credential helper ever ran. Challenge only a request that is
    // unmistakably git smart-HTTP, so an ordinary visitor to a hosted site is
    // never asked for a password.
    if (looksLikeGit({ pathname, request, search })) {
      return new Response('authentication required\n', {
        headers: { 'WWW-Authenticate': 'Basic realm="kyto"' },
        status: 401,
      });
    }
    return null;
  }
  // A write's body is buffered so its target can be read out of it; a git pack
  // (which can be large, and never needs parsing) is streamed straight through.
  const isGit = GIT_PATH.test(pathname);
  const method = request.method.toUpperCase();
  const needsBody = !(isGit || READ_METHODS.has(method));
  const raw = needsBody ? await request.arrayBuffer() : undefined;
  if (raw && raw.byteLength > MAX_BUFFERED_BODY) {
    return refusal('Request body is too large for the kyto GitHub proxy.', 413);
  }
  const body = raw ? Buffer.from(raw).toString('utf8') : undefined;
  const target = await classify({ body, method, pathname, search });
  if (!target) {
    return null;
  }

  if (target.write) {
    if (!target.understood) {
      return refusal(
        'Refused: this write does not name a repository the kyto GitHub proxy can check, so it cannot be authorized. Use the normal `gh`/`git` commands against a specific repo (a REST call under /repos/{owner}/{name}, or a GraphQL mutation that names the repository) instead of a raw call the guard cannot read.',
        403
      );
    }
    if (!principal.userId) {
      // Same rule as a detached shell command: with nobody to check the write
      // against, it is refused rather than allowed.
      return refusal(
        'Refused: this GitHub write has no requesting user to authorize it against.',
        403
      );
    }
    const guard = await guardGithubTargets({
      commandText: `${method} ${pathname}`,
      creates: target.creates,
      isOwner: principal.isOwner,
      repos: target.repos,
      threadId: principal.threadId,
      userId: principal.userId,
    });
    if (!guard.allowed) {
      logger.info(
        { method, pathname, repos: target.repos, userId: principal.userId },
        '[github-proxy] refused a write'
      );
      return refusal(guard.reason, 403);
    }
    const response = await forward({ body: raw, request, target });
    // GraphQL answers 200 even when the mutation failed, so a body carrying
    // `errors` claims nothing — else a failing mutation naming a repo kyto
    // hasn't created yet would squat it for whoever sent it.
    const graphqlFailed =
      pathname === GRAPHQL_PATH &&
      (await response
        .clone()
        .json()
        .then(
          (json: unknown) =>
            typeof json === 'object' && json !== null && 'errors' in json,
          () => true
        ));
    if (response.status >= 200 && response.status < 300 && !graphqlFailed) {
      // Only a write that actually SUCCEEDED claims a repo, same as the shell
      // path. A git push is the exception worth knowing about: smart HTTP
      // answers 200 and reports a rejected push inside the packet stream, so a
      // claim there means "GitHub accepted the connection", not "the branch
      // moved". It claims a repo for its requester either way, which is the
      // conservative direction.
      await guard.claim();
    }
    return response;
  }
  return await forward({ body: raw, request, target });
}

async function forward({
  body,
  request,
  target,
}: {
  body: ArrayBuffer | undefined;
  request: Request;
  target: Target;
}): Promise<Response> {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  // The real credential, attached here and nowhere else. A token GitHub no
  // longer accepts is left OFF entirely rather than sent: an Authorization
  // header GitHub rejects breaks anonymous reads of public repos too, so a dead
  // PAT should cost only the writes it can no longer do (see lib/github/token).
  const token = await brokerableGithubToken();
  if (!mayCarryPat(target.upstream)) {
    logger.error(
      { upstream: target.upstream },
      '[github-proxy] refused to send the PAT to an unexpected host'
    );
    return new Response('Refused: unexpected upstream host.', { status: 502 });
  }
  if (token) {
    headers.set(
      'authorization',
      target.upstream.startsWith('https://github.com/')
        ? `Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
        : `Bearer ${token}`
    );
  }
  try {
    const upstream = await fetch(target.upstream, {
      body:
        body ??
        (READ_METHODS.has(request.method.toUpperCase())
          ? undefined
          : request.body),
      // Streaming a request body requires half-duplex mode; Bun follows the
      // fetch spec here and rejects the request without it.
      duplex: 'half',
      headers,
      method: request.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const out = new Headers();
    for (const [key, value] of upstream.headers) {
      if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        out.set(key, value);
      }
    }
    return new Response(upstream.body, {
      headers: out,
      status: upstream.status,
    });
  } catch (error) {
    logger.warn(
      { err: error, upstream: target.upstream },
      '[github-proxy] upstream call failed'
    );
    return refusal('The kyto GitHub proxy could not reach GitHub.', 502);
  }
}

/**
 * Env that points a sandbox command at the proxy. Re-sent on EVERY command, so a
 * sandbox that outlives a turn never carries a revoked token: `gh` reads its
 * token from the environment, and the git credential helper below reads
 * `KYTO_GH_PROXY_TOKEN` at call time rather than baking it into a config file.
 */
export function githubProxyEnv(
  secret: string,
  publicHost: string
): Record<string, string> {
  return {
    // gh treats any host that isn't github.com as GitHub Enterprise Server,
    // which is exactly the shape we want: it talks to https://HOST/api/v3 and
    // https://HOST/api/graphql, both of which this module answers.
    GH_ENTERPRISE_TOKEN: secret,
    GH_HOST: publicHost,
    GITHUB_ENTERPRISE_TOKEN: secret,
    KYTO_GH_PROXY_TOKEN: secret,
  };
}

/**
 * Point `git` at the proxy. Runs at every materialization (so it must be
 * idempotent) alongside the git hardening.
 *
 * The credential helper is a shell function on purpose: it reads the token from
 * the environment when git asks for credentials, so a resumed sandbox picks up
 * the current turn's token instead of one written into `.gitconfig` weeks ago.
 */
export function githubProxyGitConfig(publicHost: string): string {
  const base = `https://${publicHost}/`;
  return [
    `git config --global credential.helper '!f() { echo username=kyto; echo "password=\${KYTO_GH_PROXY_TOKEN:-}"; }; f'`,
    `git config --global --unset-all url."${base}".insteadOf || true`,
    `git config --global --add url."${base}".insteadOf https://github.com/`,
    `git config --global --add url."${base}".insteadOf git@github.com:`,
    `git config --global --add url."${base}".insteadOf ssh://git@github.com/`,
  ].join('\n');
}
