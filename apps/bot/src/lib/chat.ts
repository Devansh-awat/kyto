import { env } from '@/env';
import { KytoBot, SlackHarness } from '@/harness';
import logger from '@/lib/logger';

// kyto's custom Slack harness (replaces the chat-sdk + @chat-adapter/slack).
// `slack` is the Web API facade; `bot` owns the Socket Mode connection and
// event routing. Same export names as before so call-sites stay stable.
export const slack = new SlackHarness({
  botToken: env.SLACK_BOT_TOKEN,
  logger,
  ...(env.KYTO_USER_TOKEN && env.KYTO_USER_COOKIE
    ? {
        userAccount: {
          cookie: env.KYTO_USER_COOKIE,
          token: env.KYTO_USER_TOKEN,
        },
      }
    : {}),
});

export const bot = new KytoBot({
  appToken: env.SLACK_APP_TOKEN,
  harness: slack,
  logger,
});

// kyto's Slack USER account, answering its own pings and DMs. Same harness
// (so both kytos know each other's posts as their own), its own connection.
export const userBot =
  env.KYTO_USER_APP_TOKEN && env.KYTO_USER_TOKEN && env.KYTO_USER_COOKIE
    ? new KytoBot({
        answersAs: 'user',
        appToken: env.KYTO_USER_APP_TOKEN,
        harness: slack,
        logger,
      })
    : undefined;
