import { describe, expect, test } from 'bun:test';
import {
  graphqlTarget as classify,
  looksLikeNodeId,
  type NodeInfo,
} from './graphql';

const body = (query: string, variables: Record<string, unknown> = {}) =>
  JSON.stringify({ query, variables });

const KNOWN: Record<string, NodeInfo> = {
  I_kwDOVictim0001: { repo: 'victim/repo', type: 'Issue' },
  R_kgDOKytoRepo01: { repo: 'kyto-agent/x', type: 'Repository' },
  U_kgDOSomeUser01: { type: 'User' },
};
const graphqlTarget = (raw: string) =>
  classify({
    body: raw,
    resolveNodes: (ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, KNOWN[id] ?? {}]))),
  });

describe('graphqlTarget', () => {
  test('a read is open', async () => {
    const target = await graphqlTarget(body('query { viewer { login } }'));
    expect(target).toMatchObject({ understood: true, write: false });
  });

  test('a repository literal in the mutation names its target', async () => {
    const target = await graphqlTarget(
      body('mutation { x: repository(owner: "Acme", name: "hello") { id } }')
    );
    expect(target.repos).toEqual(['acme/hello']);
    expect(target.understood).toBe(true);
  });

  test('owner/name variables the query never uses are not evidence', async () => {
    // The decoy: an allowed repo in the variables, the real target elsewhere.
    const target = await graphqlTarget(
      body('mutation { __typename }', { name: 'x', owner: 'kyto-agent' })
    );
    expect(target.understood).toBe(false);
  });

  test('owner/name variables the query uses are evidence', async () => {
    const target = await graphqlTarget(
      body(
        'mutation($owner: String!, $name: String!) { x: repository(owner: $owner, name: $name) { id } }',
        { name: 'hello', owner: 'acme' }
      )
    );
    expect(target.repos).toEqual(['acme/hello']);
  });

  test('a repo name with a path in it refuses the write', async () => {
    const target = await graphqlTarget(
      body(
        'mutation($owner: String!, $name: String!) { a(o: $owner, n: $name) }',
        {
          name: 'a/../../repos/victim/repo',
          owner: 'kyto-agent',
        }
      )
    );
    expect(target.understood).toBe(false);
  });

  test('nameWithOwner counts, from variables or the query', async () => {
    const fromVariables = await graphqlTarget(
      body(
        'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { clientMutationId } }',
        {
          input: {
            branch: {
              branchName: 'main',
              repositoryNameWithOwner: 'Victim/Repo',
            },
          },
        }
      )
    );
    expect(fromVariables.repos).toEqual(['victim/repo']);
    const inline = await graphqlTarget(
      body(
        'mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "victim/repo"}}) { clientMutationId } }'
      )
    );
    expect(inline.repos).toEqual(['victim/repo']);
  });

  test('a node id inline in the query text is resolved', async () => {
    const target = await graphqlTarget(
      body(
        'mutation { addComment(input: {subjectId: "I_kwDOVictim0001", body: "x"}) { clientMutationId } }',
        { name: 'x', owner: 'kyto-agent' }
      )
    );
    expect(target.repos).toEqual(['victim/repo']);
  });

  test('a node id under any key is resolved', async () => {
    const target = await graphqlTarget(
      body('mutation($input: X!) { a(input: $input) { b } }', {
        input: { labelableThing: 'I_kwDOVictim0001' },
      })
    );
    expect(target.repos).toEqual(['victim/repo']);
  });

  test('an id that resolves to no repo refuses, unless it is a person', async () => {
    const unknown = await graphqlTarget(
      body('mutation($input: X!) { a(input: $input) { b } }', {
        input: {
          repositoryId: 'R_kgDOKytoRepo01',
          subjectId: 'I_kwDOUnknown999',
        },
      })
    );
    expect(unknown.understood).toBe(false);
    const reviewers = await graphqlTarget(
      body('mutation($input: X!) { a(input: $input) { b } }', {
        input: {
          repositoryId: 'R_kgDOKytoRepo01',
          userIds: ['U_kgDOSomeUser01'],
        },
      })
    );
    expect(reviewers).toMatchObject({
      repos: ['kyto-agent/x'],
      understood: true,
    });
  });

  test('a git object id is not a node', async () => {
    const target = await graphqlTarget(
      body('mutation($input: X!) { mergePullRequest(input: $input) { b } }', {
        input: {
          expectedHeadOid: 'a'.repeat(40),
          repositoryId: 'R_kgDOKytoRepo01',
        },
      })
    );
    expect(target).toMatchObject({ repos: ['kyto-agent/x'], understood: true });
  });

  test('unparseable bodies refuse', async () => {
    expect((await graphqlTarget('{nope')).understood).toBe(false);
  });
});

describe('looksLikeNodeId', () => {
  test('recognises modern and legacy ids', () => {
    expect(looksLikeNodeId('PR_kwDOAbCdEf4ZyXwV')).toBe(true);
    expect(looksLikeNodeId('R_kgDOH1a2b3')).toBe(true);
    // base64 of "010:Repository12345"
    // cspell:disable-next-line
    expect(looksLikeNodeId('MDEwOlJlcG9zaXRvcnkxMjM0NQ==')).toBe(true);
  });

  test('leaves ordinary strings alone', () => {
    for (const value of [
      'main',
      'feature/login',
      'fix-the-thing',
      'Hello world',
      'a'.repeat(40),
    ]) {
      expect(looksLikeNodeId(value)).toBe(false);
    }
  });
});
