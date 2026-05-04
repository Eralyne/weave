import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Weave } from '@weave/core';
import type { WeaveConfig } from '@weave/core';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const DEFAULT_REFRESH_INTERVAL_MS = 3000;

function resolveProjectRoot(projectRootArg?: string): string {
  return resolve(projectRootArg ?? process.env.WEAVE_PROJECT_ROOT ?? process.cwd());
}

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

function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function createRuntime(projectRootArg?: string) {
  const projectRoot = resolveProjectRoot(projectRootArg);
  const config = loadConfig(projectRoot);
  const weave = new Weave(projectRoot, config);
  let lastRefreshAt = 0;

  async function ensureReady(force = false): Promise<void> {
    const now = Date.now();
    if (!force && lastRefreshAt > 0 && now - lastRefreshAt < DEFAULT_REFRESH_INTERVAL_MS) {
      return;
    }

    await weave.refresh();
    lastRefreshAt = now;
  }

  return {
    projectRoot,
    weave,
    ensureReady,
  };
}

export function createServer(projectRootArg?: string): McpServer {
  const runtime = createRuntime(projectRootArg);
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
        await runtime.ensureReady();
        const result = runtime.weave.query({
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
    'weave_context',
    'Compact task context bundle for agents: working set, mined constraints, and exemplar files',
    {
      file: z.string().describe('File path relative to project root'),
      scope: z.string().optional().describe('Natural-language scope hint for traversal'),
      depth: z.number().optional().describe('Max traversal depth (default: 3)'),
      maxFiles: z.number().optional().describe('Max files to include in the working set'),
      maxConstraints: z.number().optional().describe('Max mined constraints to include'),
      maxExemplars: z.number().optional().describe('Max exemplar files to include'),
    },
    async ({ file, scope, depth, maxFiles, maxConstraints, maxExemplars }) => {
      try {
        await runtime.ensureReady();
        const result = runtime.weave.context({
          start: file,
          scope,
          depth,
          maxFiles,
          maxConstraints,
          maxExemplars,
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'weave_bootstrap',
    'Agent-ready Weave-first bootstrap payload for a task',
    {
      file: z.string().optional().describe('Optional file path relative to project root; if omitted, Weave will infer likely entry files from the task'),
      task: z.string().describe('Task description to bootstrap'),
      scope: z.string().optional().describe('Natural-language scope hint for traversal'),
      depth: z.number().optional().describe('Max traversal depth (default: 2)'),
      maxFiles: z.number().optional().describe('Max files to include in the working set'),
      maxConstraints: z.number().optional().describe('Max mined constraints to include'),
      maxExemplars: z.number().optional().describe('Max exemplar files to include'),
    },
    async ({ file, task, scope, depth, maxFiles, maxConstraints, maxExemplars }) => {
      try {
        await runtime.ensureReady();
        const result = runtime.weave.bootstrap({
          task,
          start: file,
          scope,
          depth,
          maxFiles,
          maxConstraints,
          maxExemplars,
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
        await runtime.ensureReady();
        const result = runtime.weave.conventions(kind);
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
        await runtime.ensureReady();
        const result = runtime.weave.validate(files);
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
        await runtime.ensureReady();
        const exemplar = runtime.weave.exemplar(kind, contextNodeId);
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
        await runtime.ensureReady();
        const result = runtime.weave.impact(fileOrSymbol);
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
        await runtime.ensureReady();
        const result = await runtime.weave.status();
        return jsonResult({
          projectRoot: runtime.projectRoot,
          ...result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export async function runServer(projectRootArg?: string): Promise<void> {
  const transport = new StdioServerTransport();
  const server = createServer(projectRootArg);
  await server.connect(transport);
  console.error(`[weave-mcp] Server running on stdio for ${resolveProjectRoot(projectRootArg)}`);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  runServer(process.argv[2]).catch((error) => {
    console.error('[weave-mcp] Fatal error:', error);
    process.exit(1);
  });
}
