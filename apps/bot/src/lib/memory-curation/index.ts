import { streamAttempt, subagentAttempts } from '@repo/ai';
import {
  type CurationChange,
  deleteMemory,
  listAuthorsDueCuration,
  listMemoriesByAuthor,
  type Memory,
  memoryIdsWithFiles,
  recordMemoryCuration,
  updateMemory,
} from '@repo/db/queries';
import logger from '@/lib/logger';
import { checkPlan, mergedBody, planSchema } from '@/lib/memory-curation/plan';
import { errorMessage } from '@/lib/utils/error';

const POLL_MS = 60 * 60 * 1000;
const CURATE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
// Below this, there is nothing worth tidying and the pass isn't worth its cost.
const MIN_MEMORIES = 8;
const AUTHORS_PER_POLL = 3;
const PREVIEW_CHARS = 1200;
const CURATE_TIMEOUT_MS = 5 * 60 * 1000;

// A standalone curator prompt, no tools — the same deliberate exception as
// compaction's summarizer: nothing here mentions a toolset, so there is no
// contradiction for a model to narrate, and a background tidy-up must not be
// able to call kyto's tools.
const CURATOR_SYSTEM = `You tidy one person's saved notes ("memories") for an AI assistant. Each has an id, a title, the date it was last updated, a one-line summary and a preview of its body.

Propose two kinds of change, and only when you are confident:
- MERGE memories that are about the same thing (the same project, audit, bug, person or decision recorded more than once). Pick the one to keep (its title stays), list the ids it absorbs, and write a new one-line summary (max 200 chars) covering all of them. The bodies are joined for you, nothing is lost.
- REMOVE a memory that is clearly obsolete: a finished one-off task with no lasting value, a status that a newer memory supersedes, or something the note itself says is done and not to revisit. When in doubt, leave it.

Most passes should change little or nothing. Never merge things that are merely related; never remove a fact, a preference, a how-to or a decision.

Reply with ONLY a JSON object: {"merges":[{"keep":id,"absorb":[ids],"summary":"…","reason":"…"}],"remove":[{"id":id,"reason":"…"}]}`;

function renderMemories(memories: Memory[]): string {
  return memories
    .map((memory) => {
      const body =
        memory.body.length > PREVIEW_CHARS
          ? `${memory.body.slice(0, PREVIEW_CHARS)}…`
          : memory.body;
      return `### id ${memory.id}: ${memory.title}\nupdated ${memory.updatedAt.toISOString().slice(0, 10)} · ${memory.summary}\n${body}`;
    })
    .join('\n\n');
}

/** The model's plan, parsed out of its reply, or null when it gave none. */
async function proposePlan(memories: Memory[]) {
  for (const attempt of subagentAttempts) {
    try {
      const result = streamAttempt({
        abortSignal: AbortSignal.timeout(CURATE_TIMEOUT_MS),
        attempt,
        holder: {},
        prompt: renderMemories(memories),
        // Nobody waits on it: half price.
        serviceTier: 'flex',
        system: CURATOR_SYSTEM,
        tools: {},
      });
      const text = await result.text;
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      const parsed = planSchema.safeParse(JSON.parse(json));
      if (parsed.success) {
        return parsed.data;
      }
      logger.warn(
        { model: attempt.model },
        '[memory-curation] plan did not parse; trying the next model'
      );
    } catch (error) {
      logger.warn(
        { err: errorMessage(error), model: attempt.model },
        '[memory-curation] attempt failed; trying the next model'
      );
    }
  }
  return null;
}

const snapshot = (memory: Memory) => ({
  body: memory.body,
  id: memory.id,
  summary: memory.summary,
  title: memory.title,
});

async function curate(author: string): Promise<void> {
  // Promoted memories are the owner's custody: never curated here. Nor is one
  // with a folder attached — a merge joins bodies, and the folder of a memory
  // merged away would go with it (cascade), unrecoverable by `restore`.
  const owned = (await listMemoriesByAuthor(author)).filter(
    (memory) => !memory.isGlobal && memory.scopeKind === null
  );
  const withFiles = await memoryIdsWithFiles(owned.map(({ id }) => id));
  const memories = owned.filter(({ id }) => !withFiles.has(id));
  if (memories.length < MIN_MEMORIES) {
    return;
  }
  const proposed = await proposePlan(memories);
  if (!proposed) {
    return;
  }
  const plan = checkPlan({ memories, now: new Date(), plan: proposed });
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const changes: CurationChange[] = [];
  for (const merge of plan.merges) {
    const kept = byId.get(merge.keep);
    const absorbed = merge.absorb.flatMap((id) => byId.get(id) ?? []);
    if (!kept || absorbed.length === 0) {
      continue;
    }
    await updateMemory({
      body: mergedBody({ absorbed, kept }),
      id: kept.id,
      summary: merge.summary,
    });
    for (const memory of absorbed) {
      await deleteMemory(memory.id);
    }
    changes.push({
      action: 'merge',
      keptBefore: snapshot(kept),
      reason: merge.reason,
      removed: absorbed.map(snapshot),
    });
  }
  for (const entry of plan.remove) {
    const memory = byId.get(entry.id);
    if (!memory) {
      continue;
    }
    await deleteMemory(memory.id);
    changes.push({
      action: 'remove',
      reason: entry.reason,
      removed: [snapshot(memory)],
    });
  }
  // Recorded even when empty: the last pass is what decides when the next one
  // is due, so an author with nothing to tidy isn't asked again every hour.
  await recordMemoryCuration({ author, changes });
  logger.info(
    {
      author,
      merged: plan.merges.length,
      memories: memories.length,
      removed: plan.remove.length,
    },
    '[memory-curation] curated'
  );
}

/**
 * Boot: once an hour, tidy the memories of up to three people who are due —
 * at least eight private memories, last tidied over a week ago, changed since.
 * Everything merged or removed is kept in `memory_curations`, so the memory
 * tool's `restore` can bring it back.
 */
export function startMemoryCuration(): void {
  if (subagentAttempts.length === 0) {
    return;
  }
  let running = false;
  const tick = async (): Promise<void> => {
    const authors = await listAuthorsDueCuration({
      curatedBefore: new Date(Date.now() - CURATE_EVERY_MS),
      minMemories: MIN_MEMORIES,
    });
    for (const author of authors.slice(0, AUTHORS_PER_POLL)) {
      await curate(author).catch((error: unknown) => {
        logger.warn(
          { author, err: errorMessage(error) },
          '[memory-curation] pass failed'
        );
      });
    }
  };
  setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    tick()
      .catch((error: unknown) => {
        logger.warn(
          { err: errorMessage(error) },
          '[memory-curation] poll failed'
        );
      })
      .finally(() => {
        running = false;
      });
  }, POLL_MS);
}
