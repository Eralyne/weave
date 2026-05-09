import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Weave } from '@weave/core';
import type { BootstrapQuery, SubgraphOptions, SubgraphQuery, WeaveConfig, WeaveStatus } from '@weave/core';
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

export function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export function summarizeStatus(projectRoot: string, status: WeaveStatus) {
  const noisyFiles = status.diagnostics.files
    .filter(file => file.l2EdgesSkipped > 0 || file.l3EdgesSkipped > 0 || file.queryErrors > 0)
    .sort((a, b) =>
      (b.l2EdgesSkipped + b.l3EdgesSkipped + b.queryErrors)
      - (a.l2EdgesSkipped + a.l3EdgesSkipped + a.queryErrors),
    )
    .slice(0, 5);
  const noisyRules = status.diagnostics.pluginRules
    .filter(rule => rule.edgesSkipped > 0 || rule.queryErrors > 0)
    .sort((a, b) => (b.edgesSkipped + b.queryErrors) - (a.edgesSkipped + a.queryErrors))
    .slice(0, 5);
  const issueCount = status.diagnostics.issues.length;
  const highLevelIssues = status.diagnostics.issues
    .filter(issue => issue.reason === 'query_error')
    .slice(0, 5);
  const issueBreakdown = Array.from(status.diagnostics.issues.reduce((counts, issue) => {
    const key = [
      `layer:${issue.layer}`,
      issue.plugin ? `plugin:${issue.plugin}` : null,
      issue.rule ? `rule:${issue.rule}` : null,
      issue.classification ? `class:${issue.classification}` : null,
      `reason:${issue.reason}`,
    ].filter(Boolean).join(' ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([kind, count]) => ({ kind, count }));

  return {
    projectRoot,
    nodeCount: status.nodeCount,
    edgeCount: status.edgeCount,
    plugins: status.plugins,
    staleFileCount: status.staleFiles.length,
    staleFiles: status.staleFiles.slice(0, 20),
    diagnostics: {
      summary: {
        l2EdgesCreated: status.diagnostics.totals.l2EdgesCreated,
        l3EdgesCreated: status.diagnostics.totals.l3EdgesCreated,
        queryErrors: status.diagnostics.totals.queryErrors,
        issueCount,
        externalIssues: status.diagnostics.totals.externalIssues,
        internalIssues: status.diagnostics.totals.internalIssues,
        unknownIssues: status.diagnostics.totals.unknownIssues,
      },
      issueBreakdown,
      topFiles: noisyFiles,
      topRules: noisyRules,
      issueSamples: highLevelIssues,
      truncated: {
        files: Math.max(0, status.diagnostics.files.length - noisyFiles.length),
        pluginRules: Math.max(0, status.diagnostics.pluginRules.length - noisyRules.length),
        issues: Math.max(0, issueCount - highLevelIssues.length),
      },
    },
  };
}

type ActiveSpec = { fromSpec?: string; fromSpecText?: string };

interface QueryToolInput {
  file: string;
  scope?: string;
  depth?: number;
  lineStart?: number;
  lineEnd?: number;
  task?: string;
  fromSpec?: string;
  fromSpecText?: string;
  maxTokens?: number;
  includeConventions?: boolean;
  includeExemplars?: boolean;
  includeSnippets?: boolean;
  includeSpecContext?: boolean;
}

interface BootstrapToolInput {
  file?: string;
  task: string;
  fromSpec?: string;
  fromSpecText?: string;
  scope?: string;
  compact?: boolean;
  depth?: number;
  maxFiles?: number;
  maxConstraints?: number;
  maxExemplars?: number;
}

interface ImpactToolInput {
  fileOrSymbol: string;
  summary?: boolean;
  lineStart?: number;
  lineEnd?: number;
  task?: string;
  scope?: string;
  fromSpec?: string;
  fromSpecText?: string;
  maxTokens?: number;
  maxNodes?: number;
  maxEdges?: number;
  includeSpecContext?: boolean;
}

function resolveSpec(input: ActiveSpec, activeSpec: ActiveSpec): ActiveSpec {
  return input.fromSpec || input.fromSpecText ? input : activeSpec;
}

export function buildQueryRequest(input: QueryToolInput, activeSpec: ActiveSpec = {}): SubgraphQuery {
  const spec = resolveSpec(input, activeSpec);
  return {
    start: input.file,
    task: input.task,
    scope: input.scope,
    fromSpec: spec.fromSpec,
    fromSpecText: spec.fromSpecText,
    depth: input.depth,
    options: {
      includeConventions: input.includeConventions,
      includeExemplars: input.includeExemplars,
      includeSnippets: input.includeSnippets,
      includeSpecContext: input.includeSpecContext ?? false,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      maxTokens: input.maxTokens,
    },
  };
}

export function buildBootstrapRequest(input: BootstrapToolInput): BootstrapQuery {
  return {
    task: input.task,
    start: input.file,
    fromSpec: input.fromSpec,
    fromSpecText: input.fromSpecText,
    scope: input.scope,
    compact: input.compact ?? true,
    depth: input.depth,
    maxFiles: input.maxFiles,
    maxConstraints: input.maxConstraints,
    maxExemplars: input.maxExemplars,
  };
}

export function buildImpactOptions(input: ImpactToolInput, activeSpec: ActiveSpec = {}): SubgraphOptions {
  const spec = resolveSpec(input, activeSpec);
  return {
    summary: input.summary,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    task: input.task,
    scope: input.scope,
    fromSpec: spec.fromSpec,
    fromSpecText: spec.fromSpecText,
    maxTokens: input.maxTokens,
    maxNodes: input.maxNodes,
    maxEdges: input.maxEdges,
    includeSpecContext: input.includeSpecContext ?? false,
  };
}

function createRuntime(projectRootArg?: string) {
  const projectRoot = resolveProjectRoot(projectRootArg);
  const config = loadConfig(projectRoot);
  const weave = new Weave(projectRoot, config);
  let lastRefreshAt = 0;
  let activeSpec: { fromSpec?: string; fromSpecText?: string } = {};

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
    activeSpec() {
      return activeSpec;
    },
    setActiveSpec(spec: { fromSpec?: string; fromSpecText?: string }) {
      activeSpec = spec;
    },
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
      lineStart: z.number().int().positive().optional().describe('Optional start line to anchor the query near a specific edit range'),
      lineEnd: z.number().int().positive().optional().describe('Optional end line to anchor the query near a specific edit range'),
      task: z.string().optional().describe('Optional task text used to rank spec-related follow-up context'),
      fromSpec: z.string().optional().describe('Optional markdown spec/design doc path; defaults to the last bootstrap spec in this MCP session'),
      fromSpecText: z.string().optional().describe('Optional inline markdown spec/design doc content'),
      maxTokens: z.number().optional().describe('Token budget for the result'),
      includeConventions: z.boolean().optional().describe('Include derived conventions'),
      includeExemplars: z.boolean().optional().describe('Include exemplar references'),
      includeSnippets: z.boolean().optional().describe('Include code snippets'),
      includeSpecContext: z.boolean().optional().describe('Include summarized active spec context; defaults to false to avoid repeated bootstrap payloads'),
    },
    async ({ file, scope, depth, lineStart, lineEnd, task, fromSpec, fromSpecText, maxTokens, includeConventions, includeExemplars, includeSnippets, includeSpecContext }) => {
      try {
        await runtime.ensureReady();
        const result = runtime.weave.query(buildQueryRequest({
          file,
          scope,
          depth,
          lineStart,
          lineEnd,
          task,
          fromSpec,
          fromSpecText,
          maxTokens,
          includeConventions,
          includeExemplars,
          includeSnippets,
          includeSpecContext,
        }, runtime.activeSpec()));
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
      fromSpec: z.string().optional().describe('Optional markdown spec/design doc path; defaults to the last bootstrap spec in this MCP session'),
      fromSpecText: z.string().optional().describe('Optional inline markdown spec/design doc content'),
      depth: z.number().optional().describe('Max traversal depth (default: 3)'),
      maxFiles: z.number().optional().describe('Max files to include in the working set'),
      maxConstraints: z.number().optional().describe('Max mined constraints to include'),
      maxExemplars: z.number().optional().describe('Max exemplar files to include'),
    },
    async ({ file, scope, fromSpec, fromSpecText, depth, maxFiles, maxConstraints, maxExemplars }) => {
      try {
        await runtime.ensureReady();
        const spec = fromSpec || fromSpecText ? { fromSpec, fromSpecText } : runtime.activeSpec();
        const result = runtime.weave.context({
          start: file,
          scope,
          fromSpec: spec.fromSpec,
          fromSpecText: spec.fromSpecText,
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
      fromSpec: z.string().optional().describe('Path to a markdown spec/design doc used to seed bootstrap file references'),
      fromSpecText: z.string().optional().describe('Inline markdown spec/design doc content used to seed bootstrap file references'),
      scope: z.string().optional().describe('Natural-language scope hint for traversal'),
      compact: z.boolean().optional().describe('Return a compact prompt that summarizes repeated context instead of inlining all details'),
      depth: z.number().optional().describe('Max traversal depth (default: 2)'),
      maxFiles: z.number().optional().describe('Max files to include in the working set'),
      maxConstraints: z.number().optional().describe('Max mined constraints to include'),
      maxExemplars: z.number().optional().describe('Max exemplar files to include'),
    },
    async ({ file, task, fromSpec, fromSpecText, scope, compact, depth, maxFiles, maxConstraints, maxExemplars }) => {
      try {
        await runtime.ensureReady();
        const result = runtime.weave.bootstrap(buildBootstrapRequest({
          task,
          file,
          fromSpec,
          fromSpecText,
          scope,
          compact,
          depth,
          maxFiles,
          maxConstraints,
          maxExemplars,
        }));
        if (fromSpec || fromSpecText) {
          runtime.setActiveSpec({ fromSpec, fromSpecText });
        } else if (result.spec?.file && result.spec.file !== '<inline-spec>') {
          runtime.setActiveSpec({ fromSpec: result.spec.file });
        }
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
    'Check explicit files or the current uncommitted git worktree against derived codebase conventions',
    {
      files: z.array(z.string()).optional().describe('File paths to validate (relative to project root). If omitted, validates uncommitted git files.'),
      changedOnly: z.boolean().optional().describe('Validate uncommitted git files even when files are provided'),
      stagedOnly: z.boolean().optional().describe('Validate staged git files for pre-commit pattern checks'),
      includeSpecCoverage: z.boolean().optional().describe('Also report coverage against the active or provided spec; off by default'),
      fromSpec: z.string().optional().describe('Optional markdown spec/design doc path for spec coverage only'),
      fromSpecText: z.string().optional().describe('Optional inline markdown spec/design doc content'),
    },
    async ({ files, changedOnly, stagedOnly, includeSpecCoverage, fromSpec, fromSpecText }) => {
      try {
        await runtime.ensureReady(true);
        const spec = includeSpecCoverage || fromSpec || fromSpecText
          ? (fromSpec || fromSpecText ? { fromSpec, fromSpecText } : runtime.activeSpec())
          : {};
        const result = runtime.weave.validateWithSummary(files ?? [], {
          changedOnly,
          stagedOnly,
          includeSpecCoverage: Boolean(includeSpecCoverage || fromSpec || fromSpecText),
          fromSpec: spec.fromSpec,
          fromSpecText: spec.fromSpecText,
        });
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
      routeMethod: z.string().optional().describe('Optional HTTP route method filter for action exemplars, e.g. GET or POST'),
      subKind: z.string().optional().describe('Optional semantic shape filter, e.g. show, index, create, update, mutation'),
    },
    async ({ kind, contextNodeId, routeMethod, subKind }) => {
      try {
        await runtime.ensureReady();
        const exemplar = runtime.weave.exemplar(kind, contextNodeId, { routeMethod, subKind });
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
      summary: z.boolean().optional().describe('Return a smaller bounded result for high-fanout files'),
      lineStart: z.number().int().positive().optional().describe('Optional start line to anchor impact near a specific edit range'),
      lineEnd: z.number().int().positive().optional().describe('Optional end line to anchor impact near a specific edit range'),
      task: z.string().optional().describe('Optional task text used to rank spec-related impact context'),
      scope: z.string().optional().describe('Optional scope hint used to rank spec-related impact context'),
      fromSpec: z.string().optional().describe('Optional markdown spec/design doc path; defaults to the last bootstrap spec in this MCP session'),
      fromSpecText: z.string().optional().describe('Optional inline markdown spec/design doc content'),
      maxTokens: z.number().int().positive().optional().describe('Approximate token budget used to derive maxNodes/maxEdges'),
      maxNodes: z.number().int().positive().optional().describe('Maximum cross-file nodes to include'),
      maxEdges: z.number().int().positive().optional().describe('Maximum impact edges to include'),
      includeSpecContext: z.boolean().optional().describe('Include summarized active spec context; defaults to false to avoid repeated bootstrap payloads'),
    },
    async ({ fileOrSymbol, summary, lineStart, lineEnd, task, scope, fromSpec, fromSpecText, maxTokens, maxNodes, maxEdges, includeSpecContext }) => {
      try {
        await runtime.ensureReady();
        const result = runtime.weave.impact(fileOrSymbol, buildImpactOptions({
          fileOrSymbol,
          summary,
          lineStart,
          lineEnd,
          task,
          scope,
          fromSpec,
          fromSpecText,
          maxTokens,
          maxNodes,
          maxEdges,
          includeSpecContext,
        }, runtime.activeSpec()));
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'weave_status',
    'Index stats — compact by default; pass verbose=true for full diagnostics',
    {
      verbose: z.boolean().optional().describe('Return full diagnostics instead of a compact summary'),
    },
    async ({ verbose }) => {
      try {
        await runtime.ensureReady();
        const result = await runtime.weave.status();
        return jsonResult(verbose
          ? { projectRoot: runtime.projectRoot, ...result }
          : summarizeStatus(runtime.projectRoot, result));
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
