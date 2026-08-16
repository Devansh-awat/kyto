import { describe, expect, it } from 'bun:test';
import {
  classifyMcpTool,
  DEFAULT_MCP_RULES,
  formatToolOverrides,
  parseMcpRules,
  parseToolOverrides,
  resolveMcpRule,
} from './mcp-permissions';

describe('classifyMcpTool', () => {
  it('believes an explicit destructive annotation', () => {
    expect(
      classifyMcpTool({
        annotations: { destructiveHint: true },
        // Named like a read, annotated as a write: the server wins.
        name: 'get_report',
      })
    ).toBe('write');
    expect(
      classifyMcpTool({
        annotations: { readOnlyHint: false },
        name: 'anything',
      })
    ).toBe('write');
  });

  it('reads the ability a server states in its description', () => {
    // Both of these are verbatim shapes from the Coolify MCP server, which sends
    // `annotations: {}` on every tool and states abilities in prose instead.
    expect(
      classifyMcpTool({
        annotations: {},
        description:
          'Get logs for a resource. Requires read:sensitive ability. Output is best-effort redacted (not a guarantee).',
        name: 'get_logs',
      })
    ).toBe('sensitive');
    expect(
      classifyMcpTool({
        annotations: {},
        description:
          'Start, stop or restart a resource. Requires deploy ability.',
        name: 'control',
      })
    ).toBe('write');
  });

  it('falls back to the name when the server says nothing at all', () => {
    expect(classifyMcpTool({ name: 'list_applications' })).toBe('read');
    expect(classifyMcpTool({ name: 'search_resources' })).toBe('read');
    expect(classifyMcpTool({ name: 'cancel_deployment' })).toBe('write');
    expect(classifyMcpTool({ name: 'delete_project' })).toBe('write');
  });

  it('treats a verbless self-describing endpoint as a read', () => {
    // Real tool name, and it matches no verb at either end.
    expect(classifyMcpTool({ name: 'coolify_help' })).toBe('read');
  });

  it('counts a read that can return a credential as sensitive', () => {
    expect(classifyMcpTool({ name: 'list_env_keys' })).toBe('sensitive');
    expect(classifyMcpTool({ name: 'get_secrets' })).toBe('sensitive');
    // readOnlyHint is true and it IS a read — but it is the read that leaks.
    expect(
      classifyMcpTool({
        annotations: { readOnlyHint: true },
        name: 'fetch_logs',
      })
    ).toBe('sensitive');
  });

  it('prefers write over sensitive when a tool does both', () => {
    // The risk of `update_env` is the mutation, not the disclosure.
    expect(classifyMcpTool({ name: 'update_env' })).toBe('write');
  });

  it('refuses to guess: an unfamiliar verb is unknown, not read', () => {
    expect(classifyMcpTool({ name: 'frobnicate_widget' })).toBe('unknown');
    expect(classifyMcpTool({ name: 'thing' })).toBe('unknown');
  });
});

describe('resolveMcpRule', () => {
  it('uses the category rule by default', () => {
    expect(
      resolveMcpRule({
        category: 'write',
        rules: DEFAULT_MCP_RULES,
        tool: 'deploy',
      })
    ).toBe('ask');
    expect(
      resolveMcpRule({
        category: 'read',
        rules: DEFAULT_MCP_RULES,
        tool: 'list_projects',
      })
    ).toBe('allow');
  });

  it('lets a per-tool pin beat its category, in both directions', () => {
    const rules = {
      ...DEFAULT_MCP_RULES,
      tools: { get_logs: 'allow', list_projects: 'never' },
    } as const;
    expect(
      resolveMcpRule({ category: 'sensitive', rules, tool: 'get_logs' })
    ).toBe('allow');
    expect(
      resolveMcpRule({ category: 'read', rules, tool: 'list_projects' })
    ).toBe('never');
  });
});

describe('parseMcpRules', () => {
  it('gives an unconfigured server the safe defaults', () => {
    expect(parseMcpRules(null)).toEqual(DEFAULT_MCP_RULES);
    expect(parseMcpRules(undefined)).toEqual(DEFAULT_MCP_RULES);
  });

  it('falls back field by field rather than trusting a bad value', () => {
    const parsed = parseMcpRules({
      read: 'allow',
      // Not a rule: must not be honoured, and must not take the row down.
      write: 'yolo',
    });
    expect(parsed.read).toBe('allow');
    expect(parsed.write).toBe('ask');
    expect(parsed.tools).toEqual({});
  });

  it('never lets a malformed row open a gate', () => {
    expect(parseMcpRules('nonsense')).toEqual(DEFAULT_MCP_RULES);
    expect(parseMcpRules(42)).toEqual(DEFAULT_MCP_RULES);
  });

  it('keeps per-tool pins', () => {
    expect(
      parseMcpRules({ ...DEFAULT_MCP_RULES, tools: { deploy: 'never' } })
    ).toMatchObject({ tools: { deploy: 'never' } });
  });
});

describe('parseToolOverrides', () => {
  it('accepts colon, equals and bare separators', () => {
    expect(
      parseToolOverrides('get_logs: allow\ndeploy = never\ncontrol ask').tools
    ).toEqual({ control: 'ask', deploy: 'never', get_logs: 'allow' });
  });

  it('ignores blank lines and comments', () => {
    const parsed = parseToolOverrides('\n# my rules\nget_logs: allow\n\n');
    expect(parsed.tools).toEqual({ get_logs: 'allow' });
    expect(parsed.errors).toEqual([]);
  });

  it('reports a bad rule instead of dropping the line', () => {
    // Silently ignoring this leaves someone believing they blocked the tool.
    const parsed = parseToolOverrides('get_logs: maybe');
    expect(parsed.tools).toEqual({});
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain('allow, ask or never');
  });

  it('reports a line that is not a rule at all', () => {
    const parsed = parseToolOverrides('please block the deploy tool');
    expect(parsed.tools).toEqual({});
    expect(parsed.errors).toHaveLength(1);
  });

  it('round-trips through the modal', () => {
    const text = 'control: never\nget_logs: allow';
    expect(
      formatToolOverrides({
        ...DEFAULT_MCP_RULES,
        tools: parseToolOverrides(text).tools,
      })
    ).toBe(text);
  });

  it('treats no text as no pins', () => {
    expect(parseToolOverrides(undefined)).toEqual({ errors: [], tools: {} });
  });
});
