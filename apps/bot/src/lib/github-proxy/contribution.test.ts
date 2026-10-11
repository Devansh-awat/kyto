import { describe, expect, test } from 'bun:test';
import { classifyContribution } from './contribution';

const graphql = (query: string, input: Record<string, unknown>) =>
  classifyContribution({
    body: JSON.stringify({ query, variables: { input } }),
    method: 'POST',
    pathname: '/api/graphql',
  });
const rest = (path: string, body: Record<string, unknown>) =>
  classifyContribution({
    body: JSON.stringify(body),
    method: 'POST',
    pathname: `/api/v3/${path}`,
  });

const CREATE_PR =
  'mutation PullRequestCreate($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{id url}}}';

describe('classifyContribution', () => {
  test("gh's own createPullRequest is a PR, and its body is rewritable", () => {
    const found = graphql(CREATE_PR, {
      baseRefName: 'main',
      body: 'fixes it',
      headRefName: 'u1/fix',
      headRepositoryId: 'R_kgDOFork0001',
      repositoryId: 'R_kgDOBase0001',
      title: 'Fix',
    });
    expect(found).toMatchObject({
      baseRef: 'main',
      headRef: 'u1/fix',
      kind: 'pr',
      subjectId: 'R_kgDOBase0001',
      text: 'fixes it',
      title: 'Fix',
    });
    const rewritten = JSON.parse(found?.withText('signed') ?? '{}');
    expect(rewritten.variables.input.body).toBe('signed');
    expect(rewritten.query).toBe(CREATE_PR);
  });

  test('createIssue and addComment are contributions; an alias is fine', () => {
    expect(
      graphql(
        'mutation($input:CreateIssueInput!){createIssue(input:$input){issue{url}}}',
        { body: 'b', repositoryId: 'R_kgDOBase0001', title: 't' }
      )?.kind
    ).toBe('issue');
    expect(
      graphql(
        'mutation($input:AddCommentInput!){c: addComment(input: $input){clientMutationId}}',
        { body: 'b', subjectId: 'I_kwDOIssue001' }
      )?.kind
    ).toBe('comment');
  });

  test('a second mutation riding along is not a contribution', () => {
    for (const query of [
      'mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){clientMutationId} mergePullRequest(input:{pullRequestId:"PR_kwDOx"}){clientMutationId}}',
      'mutation A($input:X!){createPullRequest(input:$input){clientMutationId}} mutation B{deleteRepository(input:{}){clientMutationId}}',
      'mutation($input:X!){...F} fragment F on Mutation{createPullRequest(input:$input){clientMutationId}}',
      'mutation($input:X!){createPullRequest(input:$input) @include(if:true){clientMutationId}}',
      'mutation($input:X!){mergePullRequest(input:$input){clientMutationId}}',
    ]) {
      expect(graphql(query, { repositoryId: 'R_kgDOBase0001' })).toBeNull();
    }
  });

  test('an inline input is refused: it would be a body the review never saw', () => {
    expect(
      graphql(
        'mutation{createPullRequest(input:{repositoryId:"R_kgDOOther01",title:"x",body:"spam",baseRefName:"main",headRefName:"x"}){clientMutationId}}',
        { body: 'decoy', repositoryId: 'R_kgDOBase0001' }
      )
    ).toBeNull();
  });

  test('a mutation name inside a string literal does not count', () => {
    expect(
      graphql(
        'mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){clientMutationId}} # mergePullRequest',
        { body: 'mutation { x }', repositoryId: 'R_kgDOBase0001' }
      )?.kind
    ).toBe('pr');
  });

  test('REST PRs, issues and issue comments', () => {
    expect(
      rest('repos/Owner/Repo/pulls', {
        base: 'main',
        body: 'b',
        head: 'kyto-agent:u1/x',
        title: 't',
      })
    ).toMatchObject({
      headRef: 'kyto-agent:u1/x',
      kind: 'pr',
      repo: 'owner/repo',
    });
    expect(rest('repos/o/r/issues', { title: 't' })?.kind).toBe('issue');
    expect(rest('repos/o/r/issues/12/comments', { body: 'b' })).toMatchObject({
      kind: 'comment',
      number: 12,
    });
    expect(rest('repos/o/r/pulls/12/merge', {})).toBeNull();
    expect(rest('repos/o/r/issues/12', { state: 'closed' })).toBeNull();
  });
});
