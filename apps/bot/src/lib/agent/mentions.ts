import { bot, slack } from '@/lib/chat';

const mentionPattern = /<@([A-Z0-9_]+)(?:\|([^<>]+))?>/g;
// The app's Slack handle is `kyto2` (kyto's user account holds `kyto`, and
// handles are unique), so resolving its own mention by username would name a
// "kyto2" nobody calls it. Always annotate the bot's own id with its real name.
const BOT_NAME = 'kyto';

export async function annotateMentions(text: string): Promise<string> {
  const mentionNames = new Map<string, string>();
  // Slack profile pronouns per mentioned id, rendered inline so a ping tells
  // kyto how to refer to the person without a separate lookup.
  const mentionPronouns = new Map<string, string>();
  const missingIds = new Set<string>();
  const botUserId = slack.botUserId;

  for (const mention of text.matchAll(mentionPattern)) {
    const userId = mention[1];
    const label = mention[2];
    if (!userId || mentionNames.has(userId)) {
      continue;
    }
    // Both identities are display-named kyto; tell them apart in the text so
    // neither persona mistakes a ping for the other one as its own. Neutral,
    // not "you": history renders the same for both, or the cache misses.
    if (botUserId && userId === botUserId) {
      mentionNames.set(userId, `${BOT_NAME} [app]`);
      continue;
    }
    if (slack.userAccountId && userId === slack.userAccountId) {
      mentionNames.set(userId, `${BOT_NAME} [user account]`);
      continue;
    }
    if (label) {
      mentionNames.set(userId, label);
      continue;
    }
    missingIds.add(userId);
  }

  await Promise.all(
    [...missingIds].map(async (userId) => {
      const user = await bot.getUser(userId).catch(() => undefined);
      mentionNames.set(userId, user?.userName ?? userId);
      if (user?.pronouns) {
        mentionPronouns.set(userId, user.pronouns);
      }
    })
  );

  if (mentionNames.size === 0) {
    return text;
  }
  return text.replace(mentionPattern, (token, userId: string) => {
    const name = mentionNames.get(userId);
    const pronouns = mentionPronouns.get(userId);
    const suffix = pronouns ? `${userId}, ${pronouns}` : userId;
    return name ? `@${name} (${suffix})` : token;
  });
}
