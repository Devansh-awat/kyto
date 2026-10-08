import { describe, expect, test } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { mergeTools, originalToolName } from '@/lib/ai/merge-tools';

const save = tool({
  description: 'Save a note.',
  execute: ({ title }) => Promise.resolve({ saved: title }),
  inputSchema: z.object({ body: z.string(), title: z.string() }),
});
const remove = tool({
  description: 'Delete a note.',
  execute: ({ title }) => Promise.resolve({ deleted: title }),
  inputSchema: z.object({ title: z.string() }),
});
const merged = mergeTools({
  actions: { delete: remove, save },
  description: 'Notes.',
});
const run = (input: Record<string, unknown>) =>
  merged.execute?.(input, {
    context: undefined,
    messages: [],
    toolCallId: 't',
  });

describe('mergeTools', () => {
  test('dispatches to the action and validates with its own schema', async () => {
    expect(await run({ action: 'save', body: 'b', title: 'x' })).toEqual({
      saved: 'x',
    });
    expect(await run({ action: 'delete', title: 'x' })).toEqual({
      deleted: 'x',
    });
  });

  test('a field the action requires is enforced even though the flat schema makes it optional', async () => {
    const result = await run({ action: 'save', title: 'x' });
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain('body');
  });

  test('an unknown action is refused with the valid ones listed', async () => {
    const result = await run({ action: 'rename', title: 'x' });
    expect(JSON.stringify(result)).toContain('delete, save');
  });

  test('the schema is one flat object (OpenAI rejects a top-level union)', () => {
    const schema = merged.inputSchema;
    expect(schema instanceof z.ZodObject).toBe(true);
    if (schema instanceof z.ZodObject) {
      expect(Object.keys(schema.shape).sort()).toEqual([
        'action',
        'body',
        'title',
      ]);
    }
    expect(merged.description).toContain('- save: Save a note.');
  });
});

describe('originalToolName', () => {
  test('resolves a family call to the verb it stands for', () => {
    expect(
      originalToolName({ input: { action: 'once' }, toolName: 'reminders' })
    ).toBe('scheduleReminder');
    expect(originalToolName({ input: {}, toolName: 'bash' })).toBe('bash');
  });
});
