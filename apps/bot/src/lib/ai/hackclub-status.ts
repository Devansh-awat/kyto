import { z } from 'zod';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const STATUS_URL = 'https://ai.hackclub.com/up';
const STATUS_TIMEOUT_MS = 3000;
// One look per minute at most: every turn asks, and the answer only matters
// when a turn has already fallen back.
const CACHE_MS = 60 * 1000;

const statusSchema = z.looseObject({
  balanceRemaining: z.number().optional(),
  openRouter: z.boolean().optional(),
  status: z.string(),
});

let cached: { at: number; outage: Promise<string | undefined> } | undefined;

/**
 * Why Hack Club AI can't answer right now, in words for the thread, or
 * undefined when its status page says it is up (or can't be read — no news is
 * not an outage).
 *
 * A fallback used to say only "a weaker model answered", which read as kyto
 * being flaky when the cause was Hack Club's own outage; with the reason the
 * thread knows it's not worth retrying for a while.
 */
export function hackclubOutage(): Promise<string | undefined> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.outage;
  }
  const outage = fetch(STATUS_URL, {
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  })
    .then(async (response): Promise<string | undefined> => {
      if (!response.ok) {
        return `Hack Club AI's status page answers ${response.status}`;
      }
      const status = statusSchema.parse(await response.json());
      if (status.status !== 'up') {
        return `Hack Club AI reports it is ${status.status}`;
      }
      if (status.openRouter === false) {
        return "Hack Club AI's model provider is down";
      }
      if (
        status.balanceRemaining !== undefined &&
        status.balanceRemaining <= 0
      ) {
        return 'Hack Club AI is out of credit';
      }
      return;
    })
    .catch((error: unknown): undefined => {
      logger.warn(
        { err: errorMessage(error) },
        '[hackclub-status] status check failed'
      );
      return;
    });
  cached = { at: Date.now(), outage };
  return outage;
}
