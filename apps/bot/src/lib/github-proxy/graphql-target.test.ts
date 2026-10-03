import { describe, expect, test } from 'bun:test';
import { graphqlTarget, looksLikeNodeId } from './index';

const body = (query: string, variables: Record<string, unknown> = {}) =>
  JSON.stringify({ query, variables });

describe('graphqlTarget', () => {
  test('a read is open', async () => {
    const target = await graphqlTarget(body('query { viewer { login } }'));
    expect(target).toMatchObject({ understood: true, write: false });
  });

  test('a repository literal in the mutation names its target', async () => {
    const target = await graphqlTarget(
      body('mutation { x: repository(owner: "Octo", name: "hello") { id } }')
    );
    expect(target.repos).toEqual(['octo/hello']);
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
        { name: 'hello', owner: 'octo' }
      )
    );
    expect(target.repos).toEqual(['octo/hello']);
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

  test('unparseable bodies refuse', async () => {
    expect((await graphqlTarget('{nope')).understood).toBe(false);
  });
});

describe('looksLikeNodeId', () => {
  test('recognises modern and legacy ids', () => {
    expect(looksLikeNodeId('PR_kwDOAbCdEf4ZyXwV')).toBe(true);
    expect(looksLikeNodeId('R_kgDOH1a2b3')).toBe(true);
    // base64 of "010:Repository12345"
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
