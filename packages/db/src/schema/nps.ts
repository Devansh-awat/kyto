import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// An NPS (Net Promoter Score) survey card the `npsSurvey` tool posted. Unlike a
// poll, whose state rides in the message metadata, a survey lives here: it has
// a closing date, and each person's optional comment must never be written
// into a public message.
export const npsSurveys = pgTable(
  'nps_surveys',
  {
    id: serial('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    // The card itself; null only between the insert and the post.
    messageTs: text('message_ts'),
    question: text('question').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    // Set when the creator or the owner closes it early.
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [index('nps_surveys_channel_idx').on(table.channelId)]
);

export type NpsSurvey = typeof npsSurveys.$inferSelect;

// One row per person per survey: clicking another score replaces it, and the
// optional comment from the modal lands on the same row.
export const npsResponses = pgTable(
  'nps_responses',
  {
    surveyId: integer('survey_id').notNull(),
    userId: text('user_id').notNull(),
    score: integer('score').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.surveyId, table.userId] }),
    foreignKey({
      columns: [table.surveyId],
      foreignColumns: [npsSurveys.id],
    }).onDelete('cascade'),
    index('nps_responses_user_idx').on(table.userId),
  ]
);

export type NpsResponse = typeof npsResponses.$inferSelect;
