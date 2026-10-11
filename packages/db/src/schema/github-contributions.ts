import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Every PR, issue and comment kyto put on (or refused for) a repo it neither
// owns nor was invited to, on behalf of someone the owner never trusted. GitHub
// sees ONE account, `kyto-agent`, so this ledger is what tells two Slack users'
// contributions apart: the daily caps count it, and a requester whose PRs keep
// getting closed unmerged is told apart from one whose PRs land.
export const githubContributions = pgTable(
  'github_contributions',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    // Lowercased "owner/name" of the repo it went to.
    repo: text('repo').notNull(),
    // 'pr' | 'issue' | 'comment'
    kind: text('kind').notNull(),
    // 'opened' | 'refused' (by the review, which counts toward the cap) |
    // 'merged' | 'closed' (a PR closed unmerged)
    outcome: text('outcome').notNull(),
    // The PR/issue number on GitHub, once opened.
    number: integer('number'),
    threadId: text('thread_id'),
    // Why the review refused it, for the owner reading the table.
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('github_contributions_user_idx').on(table.userId, table.createdAt),
    index('github_contributions_kind_idx').on(table.kind, table.createdAt),
  ]
);

export type GithubContribution = typeof githubContributions.$inferSelect;
