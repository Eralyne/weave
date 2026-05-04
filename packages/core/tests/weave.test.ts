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
  mkdirSync(join(projectRoot, 'tests/Feature/Admin'), { recursive: true });

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
  writeFileSync(
    join(projectRoot, 'tests/Feature/Admin/HooksAdminTest.php'),
    `<?php

test('hooks admin smoke test', function () {
    expect(true)->toBeTrue();
});
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

function createCommunicationAuditProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-communication-'));

  mkdirSync(join(projectRoot, 'app/Clients'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Campaign/Turn'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Campaign/Events'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Campaign'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Admin'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Providers'), { recursive: true });
  mkdirSync(join(projectRoot, 'config'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Campaign'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/composables'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Scripts'), { recursive: true });
  mkdirSync(join(projectRoot, 'routes'), { recursive: true });
  mkdirSync(join(projectRoot, 'tests/Feature/Admin'), { recursive: true });

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
    join(projectRoot, 'app/Clients/GameEngineClient.php'),
    `<?php

namespace App\\Clients;

class GameEngineClient
{
    public function submitTurn(array $payload): array
    {
        return $payload;
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Campaign/Turn/CreateCampaignTurnAction.php'),
    `<?php

namespace App\\Actions\\Campaign\\Turn;

use App\\Clients\\GameEngineClient;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class CreateCampaignTurnAction
{
    use AsAction;

    public function __construct(private GameEngineClient $gameEngine)
    {
    }

    public function asController(): array
    {
        return $this->gameEngine->submitTurn(['ok' => true]);
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Campaign/Events/StreamEventsAction.php'),
    `<?php

namespace App\\Actions\\Campaign\\Events;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class StreamEventsAction
{
    use AsAction;

    public function asController(): array
    {
        return ['token' => 'abc'];
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Campaign/Turn/ListCampaignTurnsAction.php'),
    `<?php

namespace App\\Actions\\Campaign\\Turn;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class ListCampaignTurnsAction
{
    use AsAction;

    public function asController(): array
    {
        return ['turns' => []];
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Campaign/ShowTurnsPageAction.php'),
    `<?php

namespace App\\Actions\\Campaign;

use Inertia\\Inertia;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class ShowTurnsPageAction
{
    use AsAction;

    public function asController()
    {
        return Inertia::render('Campaign/Turns');
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Admin/CreateHookAction.php'),
    `<?php

namespace App\\Actions\\Admin;

use App\\Clients\\GameEngineClient;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class CreateHookAction
{
    use AsAction;

    public function asController(GameEngineClient $gameEngine): array
    {
        return ['ok' => true];
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Admin/ListCampaignEventsAction.php'),
    `<?php

namespace App\\Actions\\Admin;

use App\\Clients\\GameEngineClient;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class ListCampaignEventsAction
{
    use AsAction;

    public function __construct(private GameEngineClient $client)
    {
    }

    public function asController(): array
    {
        return ['events' => []];
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Providers/AppServiceProvider.php'),
    `<?php

namespace App\\Providers;

use App\\Clients\\GameEngineClient;
use Illuminate\\Support\\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(GameEngineClient::class, fn () => new GameEngineClient());
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'config/services.php'),
    `<?php

return [
    'game_engine' => [
        'url' => env('GAME_ENGINE_URL'),
        'secret' => env('GAME_ENGINE_SECRET'),
    ],
];
`,
  );

  writeFileSync(
    join(projectRoot, 'routes/api.php'),
    `<?php

use App\\Actions\\Campaign\\Events\\StreamEventsAction;
use App\\Actions\\Campaign\\Turn\\CreateCampaignTurnAction;
use Illuminate\\Support\\Facades\\Route;

Route::post('/campaigns/{campaign}/turns', CreateCampaignTurnAction::class);
Route::get('/campaigns/{campaign}/events/stream', StreamEventsAction::class);
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Scripts/api.js'),
    `export const postWithKeepalive = async (url, data = {}) => ({ url, data });
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useCampaignEvents.js'),
    `export function useCampaignEvents(campaignId) {
  return { connect() { return campaignId; } };
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useTurnResume.js'),
    `export function useTurnResume(options) {
  return { options };
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useEngineCombat.js'),
    `export function useEngineCombat(options) {
  return { options };
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Campaign/Turns.vue'),
    `<script setup>
import { postWithKeepalive } from '@/Scripts/api.js';
import { useCampaignEvents } from '@/composables/useCampaignEvents.js';
import { useTurnResume } from '@/composables/useTurnResume.js';
import { useEngineCombat } from '@/composables/useEngineCombat.js';

useCampaignEvents('1');
useTurnResume({});
useEngineCombat({});

async function submit() {
  await postWithKeepalive('/api/campaigns/1/turns', {});
}
</script>

<template>
  <button @click="submit">Submit turn</button>
</template>
`,
  );

  writeFileSync(
    join(projectRoot, 'tests/Feature/Admin/HooksAdminTest.php'),
    `<?php

test('hooks admin smoke test', function () {
    expect(true)->toBeTrue();
});
`,
  );

  return projectRoot;
}

function createInertiaSharedPropsProject(includeWeatherIntensityShare: boolean): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-inertia-shared-'));

  mkdirSync(join(projectRoot, 'app/Http/Middleware'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/composables'), { recursive: true });

  writeFileSync(join(projectRoot, 'artisan'), '#!/usr/bin/env php\n');
  writeFileSync(
    join(projectRoot, 'composer.json'),
    JSON.stringify({
      require: {
        'laravel/framework': '^11.0',
        'inertiajs/inertia-laravel': '^1.0',
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
    join(projectRoot, 'app/Http/Middleware/HandleInertiaRequests.php'),
    `<?php

namespace App\\Http\\Middleware;

use Illuminate\\Http\\Request;
use Inertia\\Middleware;

class HandleInertiaRequests extends Middleware
{
    public function share(Request $request): array
    {
        return [
            ...parent::share($request),
            'auth' => function () use ($request) {
                $user = $request->user();
                if (! $user) {
                    return ['user' => null];
                }

                return [
                    'user' => [
                        'id' => $user->id,
                        'name' => $user->name,${includeWeatherIntensityShare ? `
                        'weather_intensity' => $user->weather_intensity,` : ''}
                    ],
                ];
            },
        ];
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useWeatherIntensity.js'),
    `import { usePage } from '@inertiajs/vue3'

function resolveIntensityFromUserOrCookie(user) {
  if (user && user.weather_intensity != null) {
    return user.weather_intensity
  }

  return 60
}

export function useWeatherIntensity() {
  const page = usePage()
  return resolveIntensityFromUserOrCookie(page.props.auth?.user)
}
`,
  );

  return projectRoot;
}

function createFrontendPrecedentProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-frontend-precedent-'));

  mkdirSync(join(projectRoot, 'resources/js/Pages/Campaign'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/composables'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Scripts'), { recursive: true });

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
    join(projectRoot, 'resources/js/composables/musicContextResolver.js'),
    `export function resolveMusicContext(state) {
  return state?.inCombat ? 'combat' : 'exploration'
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useMusicEngine.js'),
    `import { resolveMusicContext } from './musicContextResolver.js'

export function useMusicEngine() {
  return {
    startContext(state) {
      return resolveMusicContext(state)
    },
  }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useWeatherPresets.js'),
    `const WEATHER_PATTERNS = [
  { pattern: /storm/i, key: 'storm' },
]

export function resolveWeatherPreset(weatherCondition) {
  return WEATHER_PATTERNS.find(({ pattern }) => pattern.test(weatherCondition ?? ''))?.key ?? 'clear'
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useMockCombat.js'),
    `export function useMockCombat() {
  return { enabled: true }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Scripts/api.js'),
    `export async function postWithKeepalive(url, data = {}) {
  return { url, data }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Campaign/Turns.vue'),
    `<script setup>
import { resolveWeatherPreset } from '@/composables/useWeatherPresets.js'
import { useMusicEngine } from '@/composables/useMusicEngine.js'
import { useMockCombat } from '@/composables/useMockCombat.js'
import { postWithKeepalive } from '@/Scripts/api.js'

resolveWeatherPreset('storm')
useMockCombat()
postWithKeepalive('/api/example', {})

const { startContext } = useMusicEngine()
startContext({ inCombat: false })
</script>

<template>
  <div>Turns</div>
</template>
`,
  );

  return projectRoot;
}

function createFrontendEventBridgeProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-frontend-bridge-'));

  mkdirSync(join(projectRoot, 'resources/js/Components/Game'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Campaign'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/composables'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/utils'), { recursive: true });
  mkdirSync(join(projectRoot, 'tests/Feature'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      dependencies: {
        vue: '^3.0.0',
      },
    }, null, 2),
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Components/Game/DebugPanel.vue'),
    `<template>
  <button @click="emit('test-dice-roll', '1d20@14')">Roll</button>
</template>

<script setup>
const emit = defineEmits(['test-dice-roll'])
</script>
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Components/Game/DiceOverlay.vue'),
    `<script setup>
import { animationToNotation } from '@/utils/diceNotation.js'
import { useDiceBox } from '@/composables/useDiceBox.js'

const { roll } = useDiceBox()
roll(animationToNotation({}))
</script>
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useDiceBox.js'),
    `export function useDiceBox() {
  return {
    roll() {},
  }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useMockCombat.js'),
    `export function useMockCombat() {
  return {
    rollDice() {
      return [20]
    },
  }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/utils/diceNotation.js'),
    `export function animationToNotation(animation) {
  return animation
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Campaign/Turns.vue'),
    `<template>
  <DebugPanel @test-dice-roll="onTestDiceRoll" />
  <DiceOverlay />
</template>

<script setup>
import DebugPanel from '@/Components/Game/DebugPanel.vue'
import DiceOverlay from '@/Components/Game/DiceOverlay.vue'
import { useDiceBox } from '@/composables/useDiceBox.js'
import { useMockCombat } from '@/composables/useMockCombat.js'

const { roll } = useDiceBox()
const mockCombat = useMockCombat()

function onTestDiceRoll(notation) {
  roll(notation)
  mockCombat.rollDice()
}
</script>
`,
  );

  writeFileSync(
    join(projectRoot, 'tests/Feature/DiceRollDebugPanelTest.php'),
    `<?php

test('debug panel dice roll smoke test', function () {
    expect(true)->toBeTrue();
});
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

  it('can self-initialize through refresh for lazy MCP startup', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      const refresh = await weave.refresh();
      expect(refresh.initialized || refresh.updatedFiles > 0).toBe(true);

      const result = weave.query({
        start: 'app/Actions/Auth/ShowLoginPageAction.php',
        depth: 1,
      });

      expect(result.nodes.some(node => node.symbol === 'ShowLoginPageAction::asController')).toBe(true);
      expect(result.edges.some(edge => edge.relationship === 'renders')).toBe(true);
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
          text: 'primary entry candidate',
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
      expect(payload.startSource).toBe('provided');
      expect(payload.operatingMode).toBe('weave_first');
      expect(payload.context.workingSet.map(file => file.file)).toContain('resources/js/Pages/Auth/Login.vue');
      expect(payload.entryCandidates[0]).toEqual(expect.objectContaining({
        file: 'app/Actions/Auth/ShowLoginPageAction.php',
      }));
      expect(payload.guidance.length).toBeGreaterThan(0);
      expect(payload.fallbackPolicy.length).toBeGreaterThan(0);
      expect(payload.prompt).toContain('You are operating in Weave-first mode.');
      expect(payload.prompt).toContain('Add a subtle login CTA copy tweak');
      expect(payload.prompt).toContain('"workingSet"');
    } finally {
      weave.close();
    }
  });

  it('can infer entry candidates from task text when no entry file is provided', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Add a small message to the login page without changing the auth flow',
        depth: 1,
        maxFiles: 4,
        maxConstraints: 4,
        maxExemplars: 3,
      });

      expect(payload.startSource).toBe('inferred');
      expect(payload.entryCandidates.length).toBeGreaterThan(0);
      expect(payload.entryCandidates.map(candidate => candidate.file)).toEqual(expect.arrayContaining([
        'resources/js/Pages/Auth/Login.vue',
      ]));
      expect(payload.entryCandidates[0]?.file.startsWith('tests/')).toBe(false);
      expect(payload.context.workingSet.map(file => file.file)).toContain('resources/js/Pages/Auth/Login.vue');
      expect(payload.prompt).toContain('Inferred entry candidates:');
    } finally {
      weave.close();
    }
  });

  it('defaults inferred bootstrap to implementation files for UI tasks', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Add a short explanatory line to the hook create page without inventing a new admin pattern',
        depth: 1,
        maxFiles: 5,
        maxConstraints: 4,
        maxExemplars: 3,
      });

      expect(payload.startSource).toBe('inferred');
      expect(payload.start.startsWith('tests/')).toBe(false);
      expect(payload.entryCandidates.some(candidate => candidate.file.startsWith('tests/'))).toBe(false);
      expect(payload.entryCandidates.map(candidate => candidate.file)).toEqual(expect.arrayContaining([
        'resources/js/Pages/Admin/Hooks/Create.vue',
      ]));
      expect(payload.context.workingSet.map(file => file.file)).toEqual(expect.arrayContaining([
        'resources/js/Pages/Admin/Hooks/Create.vue',
      ]));
    } finally {
      weave.close();
    }
  });

  it('broad communication audits widen from a provided backend start into reverse dependents, frontend surfaces, and infra files', async () => {
    const projectRoot = createCommunicationAuditProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Audit the communication architecture around game engine turn processing, realtime events, polling, and keepalive behavior',
        start: 'app/Clients/GameEngineClient.php',
        depth: 2,
        maxFiles: 12,
        maxConstraints: 6,
        maxExemplars: 3,
      });

      expect(payload.taskMode).toBe('audit_communication');
      expect(payload.entryCandidates.map(candidate => candidate.file)).toEqual(expect.arrayContaining([
        'app/Clients/GameEngineClient.php',
        'app/Actions/Campaign/Turn/CreateCampaignTurnAction.php',
        'app/Actions/Campaign/Events/StreamEventsAction.php',
        'resources/js/Pages/Campaign/Turns.vue',
      ]));
      expect(payload.entryCandidates.some(candidate => candidate.file === 'app/Actions/Admin/ListCampaignEventsAction.php')).toBe(false);
      expect(payload.entryCandidates.some(candidate => candidate.file === 'app/Actions/Campaign/Turn/ListCampaignTurnsAction.php')).toBe(false);

      const workingFiles = payload.context.workingSet.map(file => file.file);
      expect(workingFiles).toEqual(expect.arrayContaining([
        'app/Actions/Campaign/Turn/CreateCampaignTurnAction.php',
        'app/Actions/Campaign/Events/StreamEventsAction.php',
        'resources/js/Pages/Campaign/Turns.vue',
        'resources/js/composables/useCampaignEvents.js',
        'resources/js/composables/useTurnResume.js',
        'resources/js/composables/useEngineCombat.js',
        'resources/js/Scripts/api.js',
        'config/services.php',
      ]));
      expect(workingFiles.some(file => file.startsWith('tests/'))).toBe(false);
      expect(workingFiles).not.toContain('app/Actions/Admin/ListCampaignEventsAction.php');
      expect(workingFiles).not.toContain('app/Actions/Campaign/Turn/ListCampaignTurnsAction.php');
      expect(payload.context.workingSet.some(file =>
        file.file === 'config/services.php' && file.provenance === 'task_heuristic'
      )).toBe(true);
    } finally {
      weave.close();
    }
  });

  it('flags missing Inertia shared auth.user fields read through helper functions', async () => {
    const projectRoot = createInertiaSharedPropsProject(false);
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const frontendViolations = weave.validate([
        'resources/js/composables/useWeatherIntensity.js',
      ]);
      expect(frontendViolations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/composables/useWeatherIntensity.js',
          symbol: 'auth.user.weather_intensity',
          convention: 'shares auth.user.weather_intensity',
          exemplarFile: 'app/Http/Middleware/HandleInertiaRequests.php',
        }),
      ]));

      const middlewareViolations = weave.validate([
        'app/Http/Middleware/HandleInertiaRequests.php',
      ]);
      expect(middlewareViolations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Http/Middleware/HandleInertiaRequests.php',
          symbol: 'HandleInertiaRequests::share',
          convention: 'shares auth.user.weather_intensity',
          exemplarFile: 'resources/js/composables/useWeatherIntensity.js',
        }),
      ]));
    } finally {
      weave.close();
    }
  });

  it('does not flag Inertia shared auth.user fields once middleware exposes them', async () => {
    const projectRoot = createInertiaSharedPropsProject(true);
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      expect(weave.validate([
        'resources/js/composables/useWeatherIntensity.js',
        'app/Http/Middleware/HandleInertiaRequests.php',
      ])).toEqual([]);
    } finally {
      weave.close();
    }
  });

  it('surfaces nearby frontend pattern precedents for creation-like tasks without promoting low-value peers', async () => {
    const projectRoot = createFrontendPrecedentProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Build a music engine composable and context resolver for campaign turns',
        maxFiles: 8,
        maxExemplars: 3,
      });

      expect(payload.entryCandidates[0]?.file).toBe('resources/js/composables/musicContextResolver.js');
      expect(payload.entryCandidates.some(candidate => candidate.reasons.some(reason => reason.includes('build')))).toBe(false);

      const bundleFiles = new Set([
        ...payload.context.workingSet.map(file => file.file),
        ...payload.context.exemplars.map(exemplar => exemplar.file),
      ]);
      expect(bundleFiles.has('resources/js/composables/useWeatherPresets.js')).toBe(true);

      expect(payload.context.exemplars.some(exemplar => exemplar.file === 'resources/js/Scripts/api.js')).toBe(false);
      expect(payload.context.exemplars.some(exemplar => exemplar.file === 'resources/js/composables/useMockCombat.js')).toBe(false);
    } finally {
      weave.close();
    }
  });

  it('uses Vue event bridges to surface related feature files instead of lexical noise', async () => {
    const projectRoot = createFrontendEventBridgeProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Add dice roll controls to the debug panel',
        maxExemplars: 3,
      });

      expect(payload.entryCandidates.map(candidate => candidate.file)).toEqual(expect.arrayContaining([
        'resources/js/Components/Game/DebugPanel.vue',
        'resources/js/Pages/Campaign/Turns.vue',
      ]));
      expect(payload.entryCandidates.some(candidate => candidate.file.toLowerCase().includes('dice'))).toBe(true);
      expect(payload.entryCandidates.some(candidate => candidate.file === 'resources/js/composables/useMockCombat.js')).toBe(false);
      expect(payload.entryCandidates.some(candidate => candidate.file.startsWith('tests/'))).toBe(false);

      const workingFiles = payload.context.workingSet.map(file => file.file);
      expect(workingFiles).toEqual(expect.arrayContaining([
        'resources/js/Components/Game/DebugPanel.vue',
        'resources/js/Pages/Campaign/Turns.vue',
        'resources/js/Components/Game/DiceOverlay.vue',
        'resources/js/composables/useDiceBox.js',
        'resources/js/utils/diceNotation.js',
      ]));
      expect(workingFiles).not.toContain('resources/js/composables/useMockCombat.js');
      expect(workingFiles.some(file => file.startsWith('tests/'))).toBe(false);
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
