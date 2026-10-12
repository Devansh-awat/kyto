import type { CompactionEvent } from '@repo/ai/context-trim';
import type { StreamChunk } from '@/harness/types';
import { createSideChunks } from '@/lib/agent/side-chunks';
import type { CardBudget } from '@/lib/ai/stream/cards';
import logger from '@/lib/logger';

const TITLE = 'Compacting context';

const thousands = (tokens: number): string => `${(tokens / 1000).toFixed(1)}k`;

/**
 * Mid-turn compaction as the plan shows it: a card while the model writes the
 * summary, then what it saved — first estimated, then the next request's real
 * size. `merge` wraps the plan's stream, because compaction happens inside the
 * SDK's prepareStep while that stream sits idle between steps. `show: false`
 * (Kevinton, which never posts) only logs.
 */
export function createCompactionReporter({
  budget,
  context,
  show = true,
}: {
  budget?: CardBudget;
  context: Record<string, unknown>;
  show?: boolean;
}) {
  const side = createSideChunks<string | StreamChunk>();
  let id = '';
  let count = 0;
  const visible = () => show && (budget?.isVisible(id) ?? true);

  const onCompaction = (event: CompactionEvent): void => {
    logger.info({ ...context, ...event }, `[agent] compaction ${event.phase}`);
    if (event.phase === 'start') {
      count += 1;
      id = `compact-${count}-${event.step}`;
      if (show && (budget?.show({ id, kind: 'tool', title: TITLE }) ?? true)) {
        side.push({
          id,
          status: 'in_progress',
          title: TITLE,
          type: 'task_update',
        });
      }
      return;
    }
    if (event.phase === 'done') {
      budget?.finish(id);
    }
    if (!visible()) {
      return;
    }
    const output =
      event.phase === 'done'
        ? `${event.summarized ? 'Summarized' : 'Summary failed, cut old tool results:'} ${thousands(event.before)} → ~${thousands(event.estimatedAfter)} tokens (measuring…)`
        : `${thousands(event.before)} → ${thousands(event.after)} tokens, saved ${thousands(event.before - event.after)} (${Math.round(((event.before - event.after) / event.before) * 100)}%)`;
    side.push({
      id,
      output,
      status: 'complete',
      title: TITLE,
      type: 'task_update',
    });
  };

  return { merge: side.merge, onCompaction };
}
