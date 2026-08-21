import { describe, expect, test } from 'bun:test';
import type { SharedMcpServer, UserMcpServer } from '@repo/db/queries';
import { resolveTurnMcpServers } from './mcp-scope';

function server(id: string, name: string, userId: string): UserMcpServer {
  return {
    authorization: null,
    createdAt: new Date(0),
    id,
    name,
    rules: null,
    url: `https://example.com/${id}`,
    userId,
  };
}

function share(row: UserMcpServer, sharedBy: string): SharedMcpServer {
  return {
    server: row,
    share: {
      createdAt: new Date(0),
      id: `share-${row.id}`,
      scopeId: 'C1',
      scopeKind: 'channel',
      serverId: row.id,
      sharedBy,
    },
  };
}

describe('resolveTurnMcpServers', () => {
  test('own servers keep their own names', () => {
    const mine = server('s1', 'github', 'U1');
    expect(resolveTurnMcpServers({ own: [mine], shared: [] })).toEqual([
      { namespace: 'github', server: mine, sharedBy: undefined },
    ]);
  });

  // The one that matters: two people can each call a server "github", and the
  // asker's own must not be shadowed by a colleague's — a call would then run
  // on somebody else's credential.
  test('a colliding shared server is suffixed, never shadowing the asker’s', () => {
    const mine = server('s1', 'github', 'U1');
    const theirs = server('s2', 'github', 'U2');
    const resolved = resolveTurnMcpServers({
      own: [mine],
      shared: [share(theirs, 'U2')],
    });
    expect(resolved.map((entry) => entry.namespace)).toEqual([
      'github',
      'github_2',
    ]);
    expect(resolved[0]?.server.userId).toBe('U1');
    expect(resolved[1]?.server.userId).toBe('U2');
    expect(resolved[1]?.sharedBy).toBe('U2');
  });

  test('a server you shared into your own channel is listed once', () => {
    const mine = server('s1', 'github', 'U1');
    const resolved = resolveTurnMcpServers({
      own: [mine],
      shared: [share(mine, 'U1')],
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.sharedBy).toBeUndefined();
  });

  // Tool schemas serialize before the messages, so a set that reshuffles between
  // turns throws away the thread's prompt cache.
  test('order is stable regardless of input order', () => {
    const a = server('s1', 'alpha', 'U2');
    const b = server('s2', 'beta', 'U3');
    const one = resolveTurnMcpServers({
      own: [],
      shared: [share(a, 'U2'), share(b, 'U3')],
    });
    const two = resolveTurnMcpServers({
      own: [],
      shared: [share(b, 'U3'), share(a, 'U2')],
    });
    expect(one.map((entry) => entry.namespace)).toEqual(
      two.map((entry) => entry.namespace)
    );
    expect(one.map((entry) => entry.namespace)).toEqual(['alpha', 'beta']);
  });

  test('three servers of the same name all get distinct namespaces', () => {
    const resolved = resolveTurnMcpServers({
      own: [server('s1', 'notion', 'U1')],
      shared: [
        share(server('s2', 'notion', 'U2'), 'U2'),
        share(server('s3', 'notion', 'U3'), 'U3'),
      ],
    });
    expect(resolved.map((entry) => entry.namespace)).toEqual([
      'notion',
      'notion_2',
      'notion_3',
    ]);
  });
});
