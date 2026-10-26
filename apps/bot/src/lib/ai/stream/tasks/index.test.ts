import { describe, expect, test } from 'bun:test';
import { renderTask } from './index';

describe('renderTask', () => {
  // #75: an MCP "read" tool returned a database password, and the plan is
  // public.
  test("an MCP tool's result never reaches its card", () => {
    const rendered = renderTask({
      input: { databaseId: 'db-1' },
      output: { dbPassword: 'hunter2', error: 'host db.internal refused' },
      phase: 'response',
      toolName: 'mcp_orchard_get_database',
    });
    expect(rendered.output).toBe('Done.');
  });

  test("an MCP tool's error text never reaches its card", () => {
    const rendered = renderTask({
      input: {},
      output: new Error('password hunter2 rejected'),
      phase: 'error',
      toolName: 'mcp_orchard_get_database',
    });
    expect(rendered.output).not.toContain('hunter2');
    expect(rendered.output).toStartWith('Failed.');
  });
});
