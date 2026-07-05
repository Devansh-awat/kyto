import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { jsonSchema, type ToolSet, tool } from 'ai';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Generic bridge from any MCP (Model Context Protocol) server to kyto's own
// ToolSet — the `ai` package version pinned here predates
// `experimental_createMCPClient`, so this hand-rolls the same idea directly
// on `@modelcontextprotocol/sdk`: connect, list the server's tools, and wrap
// each as an `ai` tool() using `jsonSchema()` (MCP tools describe their input
// as raw JSON Schema, not Zod).
//
// Supports both transports the protocol defines: `stdio` spawns a local
// process (same host trust level as the bot process itself — there is no
// sandboxing for a configured local MCP server, same as any other host-side
// tool) and `http` speaks to a remote server over Streamable HTTP.
//
// Configured via the MCP_SERVERS env var: a JSON array of
// `{ name, transport: 'stdio' | 'http', command?, args?, env?, url?, headers? }`.
// Connections are made ONCE at process startup (see index.ts's `initMcp()`)
// and cached for the process lifetime — buildTools() runs fresh every turn,
// so reconnecting per turn would be slow and wasteful. If a server fails to
// connect, it's logged and skipped; kyto still starts up fine with zero MCP
// tools.
export interface McpServerConfig {
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
}

function parseConfig(): McpServerConfig[] {
  const raw = process.env.MCP_SERVERS;
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
  } catch (error) {
    logger.warn(
      { err: errorMessage(error) },
      '[mcp] failed to parse MCP_SERVERS (expected a JSON array)'
    );
    return [];
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

async function connectServer(config: McpServerConfig): Promise<ToolSet> {
  const client = new Client({ name: 'kyto', version: '1.0.0' });
  const transport =
    config.transport === 'stdio'
      ? new StdioClientTransport({
          args: config.args,
          command: config.command as string,
          env: config.env,
        })
      : new StreamableHTTPClientTransport(new URL(config.url as string), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
  await client.connect(transport);
  const { tools: mcpToolList } = await client.listTools();
  const toolSet: ToolSet = {};
  for (const mcpTool of mcpToolList) {
    const toolName = `mcp_${sanitize(config.name)}_${sanitize(mcpTool.name)}`;
    toolSet[toolName] = tool({
      description:
        mcpTool.description ?? `MCP tool "${mcpTool.name}" from ${config.name}`,
      execute: async (args) =>
        await client.callTool({
          arguments: args as Record<string, unknown>,
          name: mcpTool.name,
        }),
      inputSchema: jsonSchema(mcpTool.inputSchema as Record<string, unknown>),
    });
  }
  return toolSet;
}

let cached: ToolSet = {};

/** Connect to every configured MCP server once and cache the merged tool
 * set. Call at process startup (index.ts); buildTools() reads the result
 * synchronously via `mcpTools()` afterward. */
export async function initMcp(): Promise<void> {
  const configs = parseConfig();
  if (configs.length === 0) {
    return;
  }
  const merged: ToolSet = {};
  for (const config of configs) {
    try {
      Object.assign(merged, await connectServer(config));
      logger.info({ server: config.name }, '[mcp] connected');
    } catch (error) {
      logger.warn(
        { err: errorMessage(error), server: config.name },
        '[mcp] failed to connect'
      );
    }
  }
  cached = merged;
}

/** Synchronous accessor for buildTools() — empty until `initMcp()` resolves,
 * or if no servers are configured / all failed to connect. */
export function mcpTools(): ToolSet {
  return cached;
}
