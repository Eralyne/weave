import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Weave } from '@weave/core';
import type { WeaveConfig } from '@weave/core';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const projectRoot = resolve(
  process.argv[2] ?? process.env.WEAVE_PROJECT_ROOT ?? process.cwd(),
);

function loadConfig(root: string): Partial<WeaveConfig> {
  const configPath = join(root, '.weave', 'config.yaml');
  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return parseYaml(raw) as Partial<WeaveConfig>;
  } catch {
    console.error(`[weave-mcp] Failed to parse ${configPath}, using defaults`);
    return {};
  }
}

const config = loadConfig(projectRoot);
const weave = new Weave(projectRoot, config);

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await weave.init();
  initialized = true;
}

function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const server = new McpServer({
  name: 'weave',
  version: '0.1.0',
});

server.tool(
  'weave_query',
  'Subgraph query — returns minimal connected context for a file/symbol',
  {
    file: z.string().describe('File path relative to project root'),
    scope: z.string().optional().describe('Natural-language scope hint for traversal'),
    depth: z.number().optional().describe('Max traversal depth (default: 3)'),
    maxTokens: z.number().optional().describe('Token budget for the result'),
    includeConventions: z.boolean().optional().describe('Include derived conventions'),
    includeExemplars: z.boolean().optional().describe('Include exemplar references'),
    includeSnippets: z.boolean().optional().describe('Include code snippets'),
  },
  async ({ file, scope, depth, maxTokens, includeConventions, includeExemplars, includeSnippets }) => {
    try {
      await ensureInit();
      const result = weave.query({
        start: file,
        scope,
        depth,
        options: {
          includeConventions,
          includeExemplars,
          includeSnippets,
          maxTokens,
        },
      });
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  'weave_conventions',
  'Get derived conventions for a node kind',
  {
    kind: z.string().optional().describe('Node kind to filter (e.g. "action", "component")'),
  },
  async ({ kind }) => {
    try {
      await ensureInit();
      const result = weave.conventions(kind);
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  'weave_validate',
  'Check files against derived conventions',
  {
    files: z.array(z.string()).describe('File paths to validate (relative to project root)'),
  },
  async ({ files }) => {
    try {
      await ensureInit();
      const result = weave.validate(files);
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  'weave_exemplar',
  'Get the best exemplar for a given kind and optional context',
  {
    kind: z.string().describe('Node kind (e.g. "action", "component", "composable")'),
    contextNodeId: z.number().optional().describe('Node ID for context-aware exemplar selection'),
  },
  async ({ kind, contextNodeId }) => {
    try {
      await ensureInit();
      const exemplar = weave.exemplar(kind, contextNodeId);
      if (!exemplar) {
        return jsonResult({ kind, exemplar: null, message: `No exemplar found for kind "${kind}"` });
      }
      return jsonResult({
        kind,
        exemplar,
        contextNodeId: contextNodeId ?? null,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  'weave_impact',
  'Blast radius analysis — what would be affected by changing a file or symbol',
  {
    fileOrSymbol: z.string().describe('File path or symbol identifier to analyze'),
  },
  async ({ fileOrSymbol }) => {
    try {
      await ensureInit();
      const result = weave.impact(fileOrSymbol);
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  'weave_status',
  'Index stats — node/edge counts, plugin status, stale files',
  {},
  async () => {
    try {
      await ensureInit();
      const result = weave.status();
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[weave-mcp] Server running on stdio');
}

main().catch((error) => {
  console.error('[weave-mcp] Fatal error:', error);
  process.exit(1);
});
