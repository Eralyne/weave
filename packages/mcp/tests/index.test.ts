import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBootstrapRequest,
  buildImpactOptions,
  buildQueryRequest,
  createServer,
  jsonResult,
  summarizeStatus,
} from '../src/index.js';
import type { WeaveStatus } from '@weave/core';

function writeProjectFile(projectRoot: string, file: string, content: string): void {
  const fullPath = join(projectRoot, file);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function createMcpFixtureProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-mcp-e2e-'));
  writeProjectFile(projectRoot, 'docs/SPEC.md', [
    '# Lore Notes',
    '',
    'Edit `resources/js/Pages/Orders/Status.vue:2-4`.',
    'Add `resources/js/Pages/Lore/Index.vue`.',
    '',
  ].join('\n'));
  writeProjectFile(projectRoot, 'resources/js/Pages/Orders/Status.vue', [
    '<template>',
    '  <main class="order-status">',
    '    <p class="lore-anchor">{{ order.status }}</p>',
    '  </main>',
    '</template>',
    '',
    '<script setup>',
    'defineProps({ order: Object })',
    '</script>',
    '',
  ].join('\n'));
  return projectRoot;
}

describe('MCP request mapping', () => {
  it('defaults bootstrap to compact payloads', () => {
    expect(buildBootstrapRequest({
      task: 'Implement feature from docs/SPEC.md',
      fromSpec: 'docs/SPEC.md',
      maxFiles: 8,
    })).toEqual(expect.objectContaining({
      task: 'Implement feature from docs/SPEC.md',
      fromSpec: 'docs/SPEC.md',
      maxFiles: 8,
      compact: true,
    }));
  });

  it('does not repeat active spec context on follow-up query and impact calls unless requested', () => {
    const activeSpec = { fromSpec: 'docs/SPEC.md' };

    expect(buildQueryRequest({
      file: 'resources/js/Pages/Orders/Status.vue',
      includeSnippets: true,
    }, activeSpec)).toEqual(expect.objectContaining({
      fromSpec: 'docs/SPEC.md',
      options: expect.objectContaining({
        includeSpecContext: false,
        includeSnippets: true,
      }),
    }));

    expect(buildImpactOptions({
      fileOrSymbol: 'resources/js/composables/useOrderEvents.js',
      summary: true,
    }, activeSpec)).toEqual(expect.objectContaining({
      fromSpec: 'docs/SPEC.md',
      includeSpecContext: false,
      summary: true,
    }));
  });

  it('lets explicit per-call spec and spec-context options override session defaults', () => {
    expect(buildQueryRequest({
      file: 'app/Actions/Orders/ShowOrderStatusAction.php',
      fromSpec: 'docs/OVERRIDE.md',
      includeSpecContext: true,
    }, { fromSpec: 'docs/SPEC.md' })).toEqual(expect.objectContaining({
      fromSpec: 'docs/OVERRIDE.md',
      options: expect.objectContaining({
        includeSpecContext: true,
      }),
    }));
  });

  it('serializes MCP JSON as one parseable text payload', () => {
    const result = jsonResult({ ok: true, nested: { count: 1 } });

    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      nested: { count: 1 },
    });
  });

  it('summarizes status diagnostics instead of returning all issues by default', () => {
    const status: WeaveStatus = {
      nodeCount: 10,
      edgeCount: 20,
      plugins: ['laravel-actions'],
      staleFiles: [],
      diagnostics: {
        totals: {
          l2EdgesCreated: 4,
          l2EdgesSkipped: 2,
          l3EdgesCreated: 3,
          l3EdgesSkipped: 1,
          nodeCreates: 1,
          metadataUpdates: 0,
          queryErrors: 0,
          issues: 6,
          externalIssues: 4,
          internalIssues: 2,
          unknownIssues: 0,
        },
        files: [
          {
            file: 'routes/web.php',
            l2EdgesCreated: 1,
            l2EdgesSkipped: 2,
            l3EdgesCreated: 0,
            l3EdgesSkipped: 0,
            nodeCreates: 0,
            metadataUpdates: 0,
            queryErrors: 0,
          },
        ],
        pluginRules: [
          {
            plugin: 'laravel-actions',
            rule: 'action-as-controller-route',
            filesEvaluated: 1,
            matches: 1,
            edgesCreated: 1,
            edgesSkipped: 1,
            nodesCreated: 0,
            metadataUpdates: 0,
            queryErrors: 0,
          },
        ],
        issues: Array.from({ length: 6 }, (_, index) => ({
          file: `file-${index}.php`,
          layer: 2 as const,
          reason: 'missing_target' as const,
          classification: index < 4 ? 'external_dependency' as const : 'internal_unresolved' as const,
        })),
      },
    };

    const summary = summarizeStatus('/repo', status);

    expect(summary).toEqual(expect.objectContaining({
      projectRoot: '/repo',
      nodeCount: 10,
      staleFileCount: 0,
    }));
    expect(summary.diagnostics.summary.issueCount).toBe(6);
    expect(summary.diagnostics.summary.externalIssues).toBe(4);
    expect(summary.diagnostics.summary.internalIssues).toBe(2);
    expect(summary.diagnostics.topFiles).toHaveLength(1);
    expect(summary.diagnostics.truncated.issues).toBe(6);
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(status).length);
  });

  it('serves bootstrap and follow-up query through the real MCP tool protocol', async () => {
    const projectRoot = createMcpFixtureProject();
    const server = createServer(projectRoot);
    const client = new Client({ name: 'weave-mcp-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'weave_bootstrap',
        'weave_query',
        'weave_status',
      ]));

      const bootstrapResult = await client.callTool({
        name: 'weave_bootstrap',
        arguments: {
          task: 'Implement lore notes from docs/SPEC.md',
          fromSpec: 'docs/SPEC.md',
          maxFiles: 4,
          maxExemplars: 4,
        },
      });
      const bootstrapText = bootstrapResult.content[0];
      expect(bootstrapText.type).toBe('text');
      const bootstrap = JSON.parse(bootstrapText.text);

      expect(Buffer.byteLength(bootstrapText.text)).toBeLessThan(20_000);
      expect(bootstrap.workingSet).toEqual(expect.any(Array));
      expect(bootstrap.context).toBeUndefined();
      expect(bootstrap.spec.file).toBe('docs/SPEC.md');
      expect(bootstrap.prompt).toContain('Weave bootstrap summary');

      const queryResult = await client.callTool({
        name: 'weave_query',
        arguments: {
          file: 'resources/js/Pages/Orders/Status.vue',
          includeSnippets: true,
        },
      });
      const queryText = queryResult.content[0];
      expect(queryText.type).toBe('text');
      const query = JSON.parse(queryText.text);

      expect(query.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Orders/Status.vue',
        }),
      ]));
      expect(query.specContext).toBeUndefined();

      const specQueryResult = await client.callTool({
        name: 'weave_query',
        arguments: {
          file: 'resources/js/Pages/Orders/Status.vue',
          includeSpecContext: true,
        },
      });
      const specQueryText = specQueryResult.content[0];
      expect(specQueryText.type).toBe('text');
      expect(JSON.parse(specQueryText.text).specContext).toEqual(expect.objectContaining({
        file: 'docs/SPEC.md',
      }));

      const validateResult = await client.callTool({
        name: 'weave_validate',
        arguments: {
          files: ['resources/js/Pages/Orders/Status.vue'],
        },
      });
      const validateText = validateResult.content[0];
      expect(validateText.type).toBe('text');
      const validate = JSON.parse(validateText.text);
      expect(validate.summary.source).toBe('explicit_files');
      expect(validate.specCoverage).toBeUndefined();

      const specValidateResult = await client.callTool({
        name: 'weave_validate',
        arguments: {
          files: ['resources/js/Pages/Orders/Status.vue'],
          includeSpecCoverage: true,
        },
      });
      const specValidateText = specValidateResult.content[0];
      expect(specValidateText.type).toBe('text');
      expect(JSON.parse(specValidateText.text).specCoverage).toEqual(expect.objectContaining({
        file: 'docs/SPEC.md',
        uncheckedExpectedFiles: expect.arrayContaining([
          'resources/js/Pages/Lore/Index.vue',
        ]),
      }));

      const worktreeValidateResult = await client.callTool({
        name: 'weave_validate',
        arguments: {},
      });
      const worktreeValidateText = worktreeValidateResult.content[0];
      expect(worktreeValidateText.type).toBe('text');
      expect(JSON.parse(worktreeValidateText.text).worktree).toEqual(expect.objectContaining({
        source: 'git_uncommitted',
      }));
    } finally {
      await client.close();
      await server.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
