/**
 * Keep the `tools` array in the order this attempt first sent it, appending any
 * tool that appears later.
 *
 * Tool schemas serialize BEFORE the messages, so the tools array is the very
 * front of the cacheable prefix. When the model calls `loadTools`, `activeTools`
 * grows and the SDK re-serializes the tools in the toolset's own key order — so
 * a newly visible tool lands in the MIDDLE, every byte after it moves, and the
 * whole prompt stops matching the cache. Measured in the journal as
 * `divergedAt: "tools(48)", cacheable: "0%"` — 22 turns in two days, each one
 * paying full price for its entire remaining length.
 *
 * Appending instead makes the growth a pure suffix, which is exactly what a
 * prefix cache can absorb. Order carries no meaning to the model.
 */
export function stabilizeToolOrder(
  payload: Record<string, unknown>,
  state: { names: string[] }
): boolean {
  const tools = payload.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return false;
  }
  const nameOf = (tool: unknown): string | undefined => {
    const fn = (tool as { function?: { name?: unknown } }).function;
    return typeof fn?.name === 'string' ? fn.name : undefined;
  };
  const byName = new Map<string, unknown>();
  for (const tool of tools) {
    const name = nameOf(tool);
    if (name) {
      byName.set(name, tool);
    }
  }
  // A tool whose name we can't read can't be ordered; leave the payload alone
  // rather than dropping it.
  if (byName.size !== tools.length) {
    return false;
  }
  const ordered: unknown[] = [];
  const seen = new Set<string>();
  for (const name of state.names) {
    const tool = byName.get(name);
    if (tool !== undefined) {
      ordered.push(tool);
      seen.add(name);
    }
  }
  for (const tool of tools) {
    const name = nameOf(tool);
    if (name && !seen.has(name)) {
      ordered.push(tool);
      seen.add(name);
    }
  }
  state.names = [...seen];
  const same = ordered.every((tool, index) => tool === tools[index]);
  if (same) {
    return false;
  }
  payload.tools = ordered;
  return true;
}
