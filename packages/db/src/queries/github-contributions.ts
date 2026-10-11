import { and, count, desc, eq, gte, isNotNull } from 'drizzle-orm';
import { db } from '../client';
import { type GithubContribution, githubContributions } from '../schema';

export type { GithubContribution } from '../schema';

/** How many contributions of a kind since `since` — one person's, or everyone's. */
export async function countGithubContributions({
  kind,
  since,
  userId,
}: {
  kind: string;
  since: Date;
  userId?: string;
}): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(githubContributions)
    .where(
      and(
        eq(githubContributions.kind, kind),
        gte(githubContributions.createdAt, since),
        userId ? eq(githubContributions.userId, userId) : undefined
      )
    );
  return row?.total ?? 0;
}

export async function recordGithubContribution(input: {
  kind: string;
  number?: number;
  outcome: string;
  reason?: string;
  repo: string;
  threadId?: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(githubContributions)
    .values({ ...input, repo: input.repo.toLowerCase() });
}

/** A person's PRs (or issues) that actually reached GitHub, newest first. */
export async function listGithubOpened({
  kind,
  since,
  userId,
}: {
  kind: string;
  since: Date;
  userId: string;
}): Promise<GithubContribution[]> {
  return await db
    .select()
    .from(githubContributions)
    .where(
      and(
        eq(githubContributions.userId, userId),
        eq(githubContributions.kind, kind),
        isNotNull(githubContributions.number),
        gte(githubContributions.createdAt, since)
      )
    )
    .orderBy(desc(githubContributions.createdAt));
}

export async function resolveGithubContribution({
  id,
  outcome,
  resolvedAt,
}: {
  id: number;
  outcome: 'closed' | 'merged';
  resolvedAt: Date;
}): Promise<void> {
  await db
    .update(githubContributions)
    .set({ outcome, resolvedAt })
    .where(eq(githubContributions.id, id));
}
