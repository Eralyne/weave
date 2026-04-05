import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Weave } from '../src/weave.js';
import { SymbolExtractor } from '../src/parser/symbols.js';
import { TreeSitterParser } from '../src/parser/parser.js';

function createFixtureProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-fixture-'));

  mkdirSync(join(projectRoot, 'app/Actions/Auth'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Admin'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Auth'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Admin/Hooks'), { recursive: true });
  mkdirSync(join(projectRoot, 'routes'), { recursive: true });

  writeFileSync(join(projectRoot, 'artisan'), '#!/usr/bin/env php\n');
  writeFileSync(
    join(projectRoot, 'composer.json'),
    JSON.stringify({
      require: {
        'laravel/framework': '^11.0',
        'inertiajs/inertia-laravel': '^1.0',
        'lorisleiva/laravel-actions': '^2.0',
      },
    }, null, 2),
  );
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      dependencies: {
        vue: '^3.0.0',
        '@inertiajs/vue3': '^1.0.0',
      },
    }, null, 2),
  );
  writeFileSync(
    join(projectRoot, 'app/Actions/Auth/ShowLoginPageAction.php'),
    `<?php

namespace App\\Actions\\Auth;

use Inertia\\Inertia;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class ShowLoginPageAction
{
    use AsAction;

    public function helper(): void
    {
    }

    public function asController(): mixed
    {
        return Inertia::render('Auth/Login', [
            'canResetPassword' => true,
        ]);
    }
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Auth/Login.vue'),
    `<script setup lang="ts">
defineProps<{ canResetPassword: boolean }>()
</script>

<template>
  <div>Login</div>
</template>
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Actions/Admin/ShowHookCreatePageAction.php'),
    `<?php

namespace App\\Actions\\Admin;

use Inertia\\Inertia;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class ShowHookCreatePageAction
{
    use AsAction;

    public function asController()
    {
        return Inertia::render('Admin/Hooks/Create');
    }
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Admin/Hooks/Create.vue'),
    `<template>
  <div>Create Hook</div>
</template>
`,
  );
  writeFileSync(
    join(projectRoot, 'routes/web.php'),
    `<?php

use App\\Actions\\Admin\\ShowHookCreatePageAction;
use App\\Actions\\Auth\\ShowLoginPageAction;
use Illuminate\\Support\\Facades\\Route;

Route::get('/login', ShowLoginPageAction::class);
Route::get('/admin/hooks/create', ShowHookCreatePageAction::class);
`,
  );

  return projectRoot;
}

function createDiagnosticsProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-diagnostics-'));

  mkdirSync(join(projectRoot, 'app/Actions/Auth'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js'), { recursive: true });
  mkdirSync(join(projectRoot, 'routes'), { recursive: true });

  writeFileSync(join(projectRoot, 'artisan'), '#!/usr/bin/env php\n');
  writeFileSync(
    join(projectRoot, 'composer.json'),
    JSON.stringify({
      require: {
        'laravel/framework': '^11.0',
        'lorisleiva/laravel-actions': '^2.0',
      },
    }, null, 2),
  );
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      dependencies: {
        vue: '^3.0.0',
      },
    }, null, 2),
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Auth/RealAction.php'),
    `<?php

namespace App\\Actions\\Auth;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class RealAction
{
    use AsAction;
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/app.ts'),
    `import { missingThing } from './missing'

export function boot() {
  return missingThing()
}
`,
  );

  writeFileSync(
    join(projectRoot, 'routes/web.php'),
    `<?php

use App\\Actions\\Auth\\MissingAction;
use Illuminate\\Support\\Facades\\Route;

Route::get('/broken', MissingAction::class);
`,
  );

  return projectRoot;
}

const createdProjects: string[] = [];

afterEach(() => {
  for (const projectRoot of createdProjects.splice(0)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('Weave integration', () => {
  it('extracts php extends edges and preserves receiver-qualified call names', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'weave-php-extract-'));
    createdProjects.push(projectRoot);

    mkdirSync(join(projectRoot, 'app'), { recursive: true });
    const file = join(projectRoot, 'app', 'SyncHooksCommand.php');
    writeFileSync(file, `<?php

use Illuminate\\Console\\Command;

class SyncHooksCommand extends Command
{
    public function handle($service): int
    {
        Hook::all();
        $service->updateHook([]);
        return Command::SUCCESS;
    }
}
`);

    const extractor = new SymbolExtractor(new TreeSitterParser());
    const result = extractor.extractFull(file);

    expect(result.edges).toContainEqual(expect.objectContaining({
      relationship: 'extends',
      metadata: expect.objectContaining({
        sourceSymbol: 'SyncHooksCommand',
        targetSymbol: 'Command',
      }),
    }));

    const callTargets = result.edges
      .filter(edge => edge.relationship === 'calls')
      .map(edge => (edge.metadata ?? {})['targetSymbol']);

    expect(callTargets).toContain('Hook::all');
    expect(callTargets).toContain('$service.updateHook');
  });

  it('builds convention edges against relative file paths and selects the enclosing symbol', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      const stats = await weave.init();
      expect(stats.plugins).toEqual(expect.arrayContaining([
        'inertia',
        'laravel-actions',
        'laravel-core',
        'vue-composition',
      ]));

      const result = weave.query({
        start: 'app/Actions/Auth/ShowLoginPageAction.php',
        depth: 2,
        options: { includeSnippets: true },
      });

      const methodNode = result.nodes.find(
        node => node.symbol === 'ShowLoginPageAction::asController',
      );
      const pageNode = result.nodes.find(
        node =>
          node.file === 'resources/js/Pages/Auth/Login.vue'
          && node.symbol === 'Login'
          && node.kind === 'inertia_page',
      );

      expect(methodNode).toBeDefined();
      expect(methodNode?.snippet).toContain('Inertia::render');
      expect(pageNode).toBeDefined();
      expect(result.edges).toContainEqual(expect.objectContaining({
        from: methodNode?.id,
        to: pageNode?.id,
        relationship: 'renders',
        convention: 'inertia',
      }));
    } finally {
      weave.close();
    }
  });

  it('creates file-level route edges and plugin-introduced node kinds without duplicating init output', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      const firstInit = await weave.init();
      const secondInit = await weave.init();

      expect(secondInit.nodeCount).toBe(firstInit.nodeCount);
      expect(secondInit.edgeCount).toBe(firstInit.edgeCount);

      const routeResult = weave.query({
        start: 'routes/web.php',
        depth: 2,
      });
      expect(routeResult.edges.some(edge => edge.relationship === 'routes_to')).toBe(true);

      const pageResult = weave.query({
        start: 'resources/js/Pages/Auth/Login.vue',
        depth: 0,
      });
      expect(pageResult.nodes.some(node => node.kind === 'inertia_page')).toBe(true);
    } finally {
      weave.close();
    }
  });

  it('builds convention edges for inertia renders without props', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const result = weave.query({
        start: 'app/Actions/Admin/ShowHookCreatePageAction.php',
        depth: 1,
      });

      const pageNode = result.nodes.find(
        node =>
          node.file === 'resources/js/Pages/Admin/Hooks/Create.vue'
          && node.kind === 'inertia_page'
          && node.symbol === 'Create',
      );

      expect(pageNode).toBeDefined();
      expect(result.edges).toContainEqual(expect.objectContaining({
        relationship: 'renders',
        convention: 'inertia',
      }));
    } finally {
      weave.close();
    }
  });

  it('builds a compact context bundle with working files, constraints, and exemplars', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const bundle = weave.context({
        start: 'app/Actions/Auth/ShowLoginPageAction.php',
        depth: 1,
        maxFiles: 4,
        maxConstraints: 4,
        maxExemplars: 4,
      });

      expect(bundle.workingSet.map(file => file.file)).toEqual(expect.arrayContaining([
        'app/Actions/Auth/ShowLoginPageAction.php',
        'resources/js/Pages/Auth/Login.vue',
        'routes/web.php',
      ]));
      expect(bundle.workingSet[0]?.file).toBe('app/Actions/Auth/ShowLoginPageAction.php');
      expect(bundle.workingSet[0]?.provenance).toBe('explicit_graph');
      expect(bundle.workingSet[0]?.confidence).toBe(1);
      expect(bundle.workingSet[0]?.reasons).toEqual(expect.arrayContaining([
        expect.objectContaining({
          text: 'start target',
          provenance: 'explicit_graph',
          confidence: 1,
        }),
      ]));
      expect(bundle.workingSet[0]?.anchors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'ShowLoginPageAction::asController',
          kind: 'method',
        }),
      ]));

      expect(bundle.constraints.length).toBeGreaterThan(0);
      expect(bundle.constraints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: expect.stringMatching(/^(action|inertia_page|method|class)$/),
          rule: expect.any(String),
          provenance: 'mined_convention',
          advisory: true,
        }),
      ]));

      expect(bundle.exemplars.length).toBeGreaterThan(0);
      expect(bundle.exemplars.some(exemplar => exemplar.kind === 'class')).toBe(false);
      expect(bundle.exemplars[0]?.provenance).toBe('structural_similarity');
      expect(bundle.exemplars.every(exemplar => !bundle.workingSet.some(file => file.file === exemplar.file))).toBe(true);
    } finally {
      weave.close();
    }
  });

  it('builds a Weave-first bootstrap payload for wrappers', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Add a subtle login CTA copy tweak without inventing new auth flow',
        start: 'app/Actions/Auth/ShowLoginPageAction.php',
        depth: 1,
        maxFiles: 4,
        maxConstraints: 4,
        maxExemplars: 3,
      });

      expect(payload.task).toContain('login CTA');
      expect(payload.start).toBe('app/Actions/Auth/ShowLoginPageAction.php');
      expect(payload.operatingMode).toBe('weave_first');
      expect(payload.context.workingSet.map(file => file.file)).toContain('resources/js/Pages/Auth/Login.vue');
      expect(payload.guidance.length).toBeGreaterThan(0);
      expect(payload.fallbackPolicy.length).toBeGreaterThan(0);
      expect(payload.prompt).toContain('You are operating in Weave-first mode.');
      expect(payload.prompt).toContain('Add a subtle login CTA copy tweak');
      expect(payload.prompt).toContain('"workingSet"');
    } finally {
      weave.close();
    }
  });

  it('handles deleted files during incremental update', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const deletedPath = join(projectRoot, 'resources/js/Pages/Auth/Login.vue');

    const weave = new Weave(projectRoot);
    try {
      await weave.init();
      rmSync(deletedPath, { force: true });

      await expect(weave.update([deletedPath])).resolves.toBeUndefined();

      const result = weave.query({
        start: 'resources/js/Pages/Auth/Login.vue',
        depth: 0,
      });
      expect(result.nodes).toHaveLength(0);
    } finally {
      weave.close();
    }
  });

  it('reports skipped L2 and L3 edges in status diagnostics', async () => {
    const projectRoot = createDiagnosticsProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();
      const status = await weave.status();

      expect(status.diagnostics.totals.l2EdgesSkipped).toBeGreaterThan(0);
      expect(status.diagnostics.totals.l3EdgesSkipped).toBeGreaterThan(0);

      expect(status.diagnostics.files).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/app.ts',
          l2EdgesSkipped: expect.any(Number),
        }),
        expect.objectContaining({
          file: 'routes/web.php',
          l3EdgesSkipped: expect.any(Number),
        }),
      ]));

      expect(status.diagnostics.pluginRules).toEqual(expect.arrayContaining([
        expect.objectContaining({
          plugin: 'laravel-actions',
          rule: 'action-as-controller-route',
          edgesSkipped: expect.any(Number),
        }),
      ]));

      expect(status.diagnostics.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/app.ts',
          layer: 2,
        }),
        expect.objectContaining({
          file: 'routes/web.php',
          layer: 3,
          plugin: 'laravel-actions',
        }),
      ]));
    } finally {
      weave.close();
    }

    const freshWeave = new Weave(projectRoot);
    try {
      const freshStatus = await freshWeave.status();
      expect(freshStatus.diagnostics.totals.l2EdgesSkipped).toBeGreaterThan(0);
      expect(freshStatus.diagnostics.totals.l3EdgesSkipped).toBeGreaterThan(0);
    } finally {
      freshWeave.close();
    }
  });
});
