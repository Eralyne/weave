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
  mkdirSync(join(projectRoot, 'resources/js/Pages/Auth'), { recursive: true });
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
    join(projectRoot, 'routes/web.php'),
    `<?php

use App\\Actions\\Auth\\ShowLoginPageAction;
use Illuminate\\Support\\Facades\\Route;

Route::get('/login', ShowLoginPageAction::class);
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
      expect(routeResult.edges.filter(edge => edge.relationship === 'routes_to')).toHaveLength(1);

      const pageResult = weave.query({
        start: 'resources/js/Pages/Auth/Login.vue',
        depth: 0,
      });
      expect(pageResult.nodes.some(node => node.kind === 'inertia_page')).toBe(true);
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
});
