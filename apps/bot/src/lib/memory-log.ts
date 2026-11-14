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

  // The type counts show WHAT grows (closures, Sets) but not who holds them.
  // `kill -USR2 1` in the pod writes a full snapshot; two of them hours apart,
  // diffed in Chrome DevTools (Comparison view), name the retainer.
  process.on('SIGUSR2', () => {
    const path = `/tmp/kyto-${Date.now()}.heapsnapshot`;
    Bun.gc(true);
    Bun.write(path, Bun.generateHeapSnapshot('v8'))
      .then(() => logger.info({ path }, '[mem] heap snapshot written'))
      .catch((error: unknown) =>
        logger.warn({ err: error }, '[mem] heap snapshot failed')
      );
  });
}
