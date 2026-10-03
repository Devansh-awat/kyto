import { env } from '@/env';
import logger from '@/lib/logger';

/**
 * Is kyto's GitHub token actually usable?
 *
 * The GitHub proxy (lib/github-proxy) attaches the token to requests it
 * forwards. A DEAD token attached to a request doesn't just break authenticated
 * work — it breaks anonymous work too: `git clone` of a PUBLIC repo fails with
 * "Invalid username or token", because GitHub rejects the credential before it
 * considers the request anonymous. A whole turn was once spent concluding a
 * public repo must be private.
 *
 * So: ask GitHub once whether the token is any good, and only attach it if it
 * is. A rejected token is left off entirely, which costs nothing that wasn't
 * already broken (authenticated work fails either way) and buys back every
 * public read. The verdict is re-checked periodically, so rotating GH_TOKEN
 * doesn't need a restart.
 */

// How long a verdict is trusted. Short enough that a rotated token starts
// working without a restart, long enough that this is not a per-turn API call.
const VERDICT_TTL_MS = 15 * 60 * 1000;

// GitHub answers a bad credential with 401, and a token whose scopes were
// stripped (or that an org blocked) with 403. Either way it cannot be brokered.
const REJECTED = new Set([401, 403]);

const CHECK_TIMEOUT_MS = 10_000;

interface Verdict {
  checkedAt: number;
  live: boolean;
}

let verdict: Verdict | undefined;
let inFlight: Promise<Verdict> | undefined;

async function askGithub(token: string): Promise<Verdict> {
  const checkedAt = Date.now();
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (REJECTED.has(response.status)) {
      logger.warn(
        { status: response.status },
        '[github] token was rejected; it will NOT be brokered into sandboxes, so public repos stay readable anonymously'
      );
      return { checkedAt, live: false };
    }
    if (!response.ok) {
      // A 5xx or a rate limit says nothing about the token. Keep whatever we
      // believed before rather than downgrading on a GitHub blip.
      logger.warn(
        { status: response.status },
        '[github] token check was inconclusive; keeping the previous verdict'
      );
      return { checkedAt, live: verdict?.live ?? true };
    }
    return { checkedAt, live: true };
  } catch (error) {
    // Same reasoning as a 5xx: an unreachable api.github.com is not evidence.
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      '[github] token check failed to reach GitHub; keeping the previous verdict'
    );
    return { checkedAt, live: verdict?.live ?? true };
  }
}

/**
 * The GitHub token for the proxy to attach, or `undefined` when there is none
 * configured or the configured one is rejected — then requests go to GitHub
 * unauthenticated, which is what keeps public reads working.
 */
export async function brokerableGithubToken(): Promise<string | undefined> {
  const token = env.GH_TOKEN;
  if (!token) {
    return;
  }
  const fresh = verdict && Date.now() - verdict.checkedAt < VERDICT_TTL_MS;
  if (fresh) {
    return verdict?.live ? token : undefined;
  }
  // Collapse concurrent checks (several turns can start at once) into one call.
  inFlight ??= askGithub(token).finally(() => {
    inFlight = undefined;
  });
  verdict = await inFlight;
  return verdict.live ? token : undefined;
}
