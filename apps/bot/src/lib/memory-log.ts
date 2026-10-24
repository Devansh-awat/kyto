import { heapStats } from 'bun:jsc';
import type { ThreadCache } from '@/harness/thread-cache';
import logger from '@/lib/logger';

// The process grew ~10-25 MB an hour between deploys with no single obvious
// cause. A periodic line of what the heap holds is what pins it down: diff
// two of them hours apart in get_deployment_logs.
const INTERVAL_MS = 30 * 60 * 1000;
const TOP_TYPES = 10;
const MB = 1024 * 1024;

export function startMemoryLog(threadCache: ThreadCache): void {
  const tick = (): void => {
    const stats = heapStats();
    const top = Object.entries(stats.objectTypeCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, TOP_TYPES);
    logger.info(
      {
        heapMb: Math.round(stats.heapSize / MB),
        objects: stats.objectCount,
        rssMb: Math.round(process.memoryUsage().rss / MB),
        threadCache: threadCache.size,
        top: Object.fromEntries(top),
      },
      '[mem] snapshot'
    );
  };
  setInterval(tick, INTERVAL_MS).unref();
  tick();
}
