import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  mkdirSync(join(projectRoot, 'resources/js/Pages'), { recursive: true });
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
import Layout from '@/Pages/Layout.vue'
import { usePage } from '@inertiajs/vue3'

defineOptions({ layout: Layout })
defineProps<{ canResetPassword: boolean }>()
const page = usePage()
</script>

<template>
  <div>Login</div>
</template>
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Layout.vue'),
    `<template>
  <main><slot /></main>
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
    `import { ref } from 'vue'
import { missingThing } from './missing'

export function boot() {
  ref(false)
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

function createHighFanoutImpactProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-impact-fanout-'));
  mkdirSync(join(projectRoot, 'src/shared'), { recursive: true });
  mkdirSync(join(projectRoot, 'src/features'), { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  writeFileSync(
    join(projectRoot, 'src/shared/hub.js'),
    `export function hub(value) {
  return value;
}
`,
  );

  for (let index = 0; index < 36; index += 1) {
    writeFileSync(
      join(projectRoot, `src/features/consumer${index}.js`),
      `import { hub } from '../shared/hub.js';

export function consumer${index}() {
  return hub(${index});
}
`,
    );
  }

  return projectRoot;
}

function createLaravelKindProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-laravel-kinds-'));

  mkdirSync(join(projectRoot, 'app/Models'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Services'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Clients'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Enums'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Support'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Http/Requests'), { recursive: true });
  mkdirSync(join(projectRoot, 'database/migrations'), { recursive: true });
  mkdirSync(join(projectRoot, 'config/lore'), { recursive: true });
  mkdirSync(join(projectRoot, 'tests/Feature'), { recursive: true });

  writeFileSync(join(projectRoot, 'artisan'), '#!/usr/bin/env php\n');
  writeFileSync(
    join(projectRoot, 'composer.json'),
    JSON.stringify({
      require: {
        'laravel/framework': '^11.0',
      },
    }, null, 2),
  );

  writeFileSync(
    join(projectRoot, 'app/Models/Post.php'),
    `<?php

namespace App\\Models;

use App\\Enums\\PostStatus;
use Illuminate\\Database\\Eloquent\\Model;

class Post extends Model
{
    protected $table = 'posts';
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Enums/PostStatus.php'),
    `<?php

namespace App\\Enums;

enum PostStatus: string
{
    case Draft = 'draft';
    case Published = 'published';
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Models/Comment.php'),
    `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Comment extends Model
{
    protected $table = 'comments';
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Http/Requests/StorePostRequest.php'),
    `<?php

namespace App\\Http\\Requests;

use Illuminate\\Foundation\\Http\\FormRequest;

class StorePostRequest extends FormRequest
{
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Http/Requests/UpdatePostRequest.php'),
    `<?php

namespace App\\Http\\Requests;

use Illuminate\\Foundation\\Http\\FormRequest;

class UpdatePostRequest extends FormRequest
{
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Services/PostPublisher.php'),
    `<?php

namespace App\\Services;

use App\\Models\\Post;
use App\\Support\\PublishesPosts;
use Illuminate\\Support\\Str;

class PostPublisher
{
    use PublishesPosts;

    public function publish(): string
    {
        Post::query();

        return Str::uuid()->toString();
    }
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Support/PublishesPosts.php'),
    `<?php

namespace App\\Support;

trait PublishesPosts
{
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Services/PostDigestBuilder.php'),
    `<?php

namespace App\\Services;

class PostDigestBuilder
{
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Clients/PublishingApiClient.php'),
    `<?php

namespace App\\Clients;

class PublishingApiClient
{
}
`,
  );
  writeFileSync(
    join(projectRoot, 'config/lore/index.php'),
    `<?php

return [
    'entries' => [],
];
`,
  );
  writeFileSync(
    join(projectRoot, 'config/lore/cosmology.php'),
    `<?php

return [
    'category' => 'cosmology',
];
`,
  );
  writeFileSync(
    join(projectRoot, 'database/migrations/2026_01_01_000000_create_posts_table.php'),
    `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
        });
    }
};
`,
  );
  writeFileSync(
    join(projectRoot, 'database/migrations/2026_01_01_000001_create_comments_table.php'),
    `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('comments', function (Blueprint $table) {
            $table->id();
        });
    }
};
`,
  );
  writeFileSync(
    join(projectRoot, 'tests/Feature/PostTest.php'),
    `<?php

test('post index works', function () {
    expect(true)->toBeTrue();
});
`,
  );
  writeFileSync(
    join(projectRoot, 'tests/Feature/CommentTest.php'),
    `<?php

test('comment index works', function () {
    expect(true)->toBeTrue();
});
`,
  );

  return projectRoot;
}

function createSpecSeedProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-spec-seed-'));
  const statusFiller = Array.from({ length: 80 }, (_, index) =>
    `    <p>Filler line ${index + 1}</p>`
  ).join('\n');

  mkdirSync(join(projectRoot, 'docs'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Orders'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Players'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Components/UI'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/composables'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Admin'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Orders'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Clients'), { recursive: true });
  mkdirSync(join(projectRoot, 'routes'), { recursive: true });
  mkdirSync(join(projectRoot, 'config'), { recursive: true });
  mkdirSync(join(projectRoot, 'public'), { recursive: true });
  mkdirSync(join(projectRoot, 'tests/Feature'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'composer.json'),
    JSON.stringify({
      require: {
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
    join(projectRoot, 'resources/js/Pages/Orders/Status.vue'),
    `<template>
  <section>
    <h1>Status</h1>
    <p id="lore-anchor">Lore copy insertion point</p>
    <p>Order details continue here.</p>
${statusFiller}
  </section>
</template>
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/composables/useOrderEvents.js'),
    `export function useOrderEvents() {
  return {}
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/composables/usePerformanceTier.js'),
    `export function usePerformanceTier() {
  return {}
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Players/Show.vue'),
    `<template><div>Players</div></template>
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Components/UI/InfoTooltip.vue'),
    `<template><span><slot /></span></template>
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Components/Alerts.vue'),
    `<template><aside>Saved</aside></template>
`,
  );
  writeFileSync(
    join(projectRoot, 'routes/web.php'),
    `<?php

use Illuminate\\Support\\Facades\\Route;
use App\\Actions\\Orders\\ShowOrderStatusAction;

Route::get('/orders/{order}', ShowOrderStatusAction::class);
`,
  );
  writeFileSync(
    join(projectRoot, 'tests/Feature/OrderStatusTest.php'),
    `<?php

test('order status renders', function () {
    expect(true)->toBeTrue();
});
`,
  );
  writeFileSync(
    join(projectRoot, 'tests/Feature/OrderEventsTest.php'),
    `<?php

test('order events process', function () {
    expect(true)->toBeTrue();
});
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Actions/Orders/ShowOrderStatusAction.php'),
    `<?php

namespace App\\Actions\\Orders;

use Inertia\\Inertia;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class ShowOrderStatusAction
{
    use AsAction;

    public function asController(): mixed
    {
        return Inertia::render('Orders/Status', [
            'order' => ['id' => 1],
        ]);
    }
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Actions/Admin/ImpersonateUserAction.php'),
    `<?php

class ImpersonateUserAction
{
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Clients/ExternalApiClient.php'),
    `<?php

namespace App\\Clients;

class ExternalApiClient
{
}
`,
  );
  writeFileSync(
    join(projectRoot, 'config/app.php'),
    `<?php

return [
    'name' => 'Fixture',
];
`,
  );
  writeFileSync(
    join(projectRoot, 'public/index.php'),
    `<?php
`,
  );
  writeFileSync(
    join(projectRoot, 'docs/LORE_FEATURE_DESIGN.md'),
    `# Lore Feature Design

| Type | Path |
| --- | --- |
| edit | \`resources/js/Pages/Orders/Status.vue:4-5\` |
| edit | \`resources/js/composables/useOrderEvents.js\` |
| edit | \`app/Actions/Orders/ShowOrderStatusAction.php\` |
| add | \`app/Services/LoreRegistry.php\` |
| add | \`app/Actions/Lore/DiscoverLoreAction.php\` |
| add | \`database/migrations/2026_01_01_000000_create_discovered_lore_table.php\` |
| add | \`tests/Feature/LoreRegistryTest.php\` |
| edit | \`InfoTooltip.vue\` |
| add | \`resources/js/Components/Lore/LoreText.vue\` |
| add | \`resources/js/composables/useLoreMatcher.js\` |
| add | \`LoreText.vue\` |
| add | \`LoreTerm.vue\` |
| add | \`Pages/Lore/Index.vue\` |
| add | \`config/lore/the_unmaking.php\` |
| edit | \`routes/web.php\` |
| note | \`index.php\` |
| content | \`the_unmaking.php\` |

Laravel implementation uses \`LoreRegistry\` for discovery highlights and segment-aware typewriter text.
## Typewriter Integration
Implementation uses \`Three.js\` for the renderer.

\`\`\`text
config/lore/
└── cosmology/
    ├── the_unmaking.php
    - the_veil.php
    └── iron_concord.php
\`\`\`
`,
  );

  return projectRoot;
}

function createCrossLanguageCallProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-cross-language-calls-'));

  mkdirSync(join(projectRoot, 'resources/js/composables'), { recursive: true });
  mkdirSync(join(projectRoot, 'config'), { recursive: true });
  mkdirSync(join(projectRoot, 'routes'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ dependencies: { vue: '^3.0.0' } }, null, 2),
  );
  writeFileSync(
    join(projectRoot, 'resources/js/composables/useSpellPreview.js'),
    `const cache = new Map();

export function useSpellPreview() {
  if (cache.has('fireball')) {
    console.warn('cached');
  }
  cache.set('fireball', true);
}
`,
  );
  writeFileSync(
    join(projectRoot, 'config/cache.php'),
    `<?php

return [];
`,
  );
  writeFileSync(
    join(projectRoot, 'routes/console.php'),
    `<?php
`,
  );

  return projectRoot;
}

function createCommunicationAuditProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-communication-'));

  mkdirSync(join(projectRoot, 'app/Clients'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Orders/Processing'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Orders/Events'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Orders'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Admin'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Providers'), { recursive: true });
  mkdirSync(join(projectRoot, 'config'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Orders'), { recursive: true });
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
    join(projectRoot, 'app/Clients/PaymentGatewayClient.php'),
    `<?php

namespace App\\Clients;

class PaymentGatewayClient
{
    public function submitOrder(array $payload): array
    {
        return $payload;
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Orders/Processing/CreateOrderProcessingAction.php'),
    `<?php

namespace App\\Actions\\Orders\\Processing;

use App\\Clients\\PaymentGatewayClient;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class CreateOrderProcessingAction
{
    use AsAction;

    public function __construct(private PaymentGatewayClient $payments)
    {
    }

    public function asController(): array
    {
        return $this->payments->submitOrder(['ok' => true]);
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Orders/Events/StreamOrderEventsAction.php'),
    `<?php

namespace App\\Actions\\Orders\\Events;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class StreamOrderEventsAction
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
    join(projectRoot, 'app/Actions/Orders/Processing/ListOrderProcessingRunsAction.php'),
    `<?php

namespace App\\Actions\\Orders\\Processing;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class ListOrderProcessingRunsAction
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
    join(projectRoot, 'app/Actions/Orders/ShowOrderStatusPageAction.php'),
    `<?php

namespace App\\Actions\\Orders;

use Inertia\\Inertia;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class ShowOrderStatusPageAction
{
    use AsAction;

    public function asController()
    {
        return Inertia::render('Orders/Status');
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Admin/CreateHookAction.php'),
    `<?php

namespace App\\Actions\\Admin;

use App\\Clients\\PaymentGatewayClient;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class CreateHookAction
{
    use AsAction;

    public function asController(PaymentGatewayClient $payments): array
    {
        return ['ok' => true];
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Admin/ListOrderEventsAction.php'),
    `<?php

namespace App\\Actions\\Admin;

use App\\Clients\\PaymentGatewayClient;
use Lorisleiva\\Actions\\Concerns\\AsAction;

class ListOrderEventsAction
{
    use AsAction;

    public function __construct(private PaymentGatewayClient $client)
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

use App\\Clients\\PaymentGatewayClient;
use Illuminate\\Support\\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(PaymentGatewayClient::class, fn () => new PaymentGatewayClient());
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'config/services.php'),
    `<?php

return [
    'payment_gateway' => [
        'url' => env('PAYMENT_GATEWAY_URL'),
        'secret' => env('PAYMENT_GATEWAY_SECRET'),
    ],
];
`,
  );

  writeFileSync(
    join(projectRoot, 'routes/api.php'),
    `<?php

use App\\Actions\\Orders\\Events\\StreamOrderEventsAction;
use App\\Actions\\Orders\\Processing\\CreateOrderProcessingAction;
use Illuminate\\Support\\Facades\\Route;

Route::post('/orders/{order}/processing', CreateOrderProcessingAction::class);
Route::get('/orders/{order}/events/stream', StreamOrderEventsAction::class);
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Scripts/api.js'),
    `export const postWithKeepalive = async (url, data = {}) => ({ url, data });
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useOrderEvents.js'),
    `export function useOrderEvents(orderId) {
  return { connect() { return orderId; } };
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/useOrderPolling.js'),
    `export function useOrderPolling(options) {
  return { options };
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/composables/usePaymentStatus.js'),
    `export function usePaymentStatus(options) {
  return { options };
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Orders/Status.vue'),
    `<script setup>
import { postWithKeepalive } from '@/Scripts/api.js';
import { useOrderEvents } from '@/composables/useOrderEvents.js';
import { useOrderPolling } from '@/composables/useOrderPolling.js';
import { usePaymentStatus } from '@/composables/usePaymentStatus.js';

useOrderEvents('1');
useOrderPolling({});
usePaymentStatus({});

async function submit() {
  await postWithKeepalive('/api/orders/1/processing', {});
}
</script>

<template>
  <button @click="submit">Submit order</button>
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

function createFrontendEndpointProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-frontend-endpoint-'));

  mkdirSync(join(projectRoot, 'app/Actions/Orders/Fulfillment'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Actions/Admin'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Orders'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/composables'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Scripts'), { recursive: true });
  mkdirSync(join(projectRoot, 'routes'), { recursive: true });
  mkdirSync(join(projectRoot, 'tests/Feature'), { recursive: true });

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
    join(projectRoot, 'routes/api.php'),
    `<?php

use App\\Actions\\Orders\\Fulfillment\\FulfillmentAction;
use App\\Actions\\Orders\\Fulfillment\\GetFulfillmentStateAction;
use App\\Actions\\Orders\\Fulfillment\\PreviewFulfillmentAction;
use Illuminate\\Support\\Facades\\Route;

Route::post('/orders/{order}/fulfillment/action', FulfillmentAction::class);
Route::get('/orders/{order}/fulfillment/state', GetFulfillmentStateAction::class);
Route::get('/orders/{order}/fulfillment/preview', PreviewFulfillmentAction::class);
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Orders/Fulfillment/FulfillmentAction.php'),
    `<?php

namespace App\\Actions\\Orders\\Fulfillment;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class FulfillmentAction
{
    use AsAction;

    public function asController(): array
    {
        return ['ok' => true];
    }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Orders/Fulfillment/GetFulfillmentStateAction.php'),
    `<?php

namespace App\\Actions\\Orders\\Fulfillment;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class GetFulfillmentStateAction
{
    use AsAction;
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Orders/Fulfillment/PreviewFulfillmentAction.php'),
    `<?php

namespace App\\Actions\\Orders\\Fulfillment;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class PreviewFulfillmentAction
{
    use AsAction;
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Admin/PreviewEmailAction.php'),
    `<?php

namespace App\\Actions\\Admin;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class PreviewEmailAction
{
    use AsAction;
}
`,
  );

  writeFileSync(
    join(projectRoot, 'app/Actions/Admin/ShowAdminOrdersPageAction.php'),
    `<?php

namespace App\\Actions\\Admin;

use Lorisleiva\\Actions\\Concerns\\AsAction;

class ShowAdminOrdersPageAction
{
    use AsAction;
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
    join(projectRoot, 'resources/js/composables/useFulfillmentApi.js'),
    `import { postWithKeepalive } from '@/Scripts/api.js'

const ACTION_PATHS = {
  ship: 'ship',
  cancel: 'cancel',
  action: 'action',
}

export function useFulfillmentApi(orderId) {
  const fulfillmentBasePath = () => \`/api/orders/\${orderId.value}/fulfillment\`

  async function sendAction(actionType, payload) {
    const path = ACTION_PATHS[actionType]
    return postWithKeepalive(\`\${fulfillmentBasePath()}/\${path}\`, payload)
  }

  async function getFulfillmentState() {
    return fetch(\`\${fulfillmentBasePath()}/state\`, { headers: { Accept: 'application/json' } })
  }

  return { sendAction, getFulfillmentState }
}
`,
  );

  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Orders/Show.vue'),
    `<script setup>
import { useFulfillmentApi } from '@/composables/useFulfillmentApi.js'

const fulfillment = useFulfillmentApi()
fulfillment.sendAction('ship', {})
</script>

<template>
  <div>Order</div>
</template>
`,
  );

  writeFileSync(
    join(projectRoot, 'tests/Feature/UpdateNotificationSettingsActionTest.php'),
    `<?php

test('notification settings smoke test', function () {
    expect(true)->toBeTrue();
});
`,
  );

  return projectRoot;
}

function createFrontendContractMigrationProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'weave-contract-migration-'));

  mkdirSync(join(projectRoot, 'app/Actions/Combat'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Clients'), { recursive: true });
  mkdirSync(join(projectRoot, 'app/Http/Requests'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Components'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/Pages/Campaign'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/composables'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/composables/__tests__'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/lang'), { recursive: true });
  mkdirSync(join(projectRoot, 'resources/js/types'), { recursive: true });

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
    join(projectRoot, 'app/Actions/Combat/CombatEndTurnAction.php'),
    `<?php

use Lorisleiva\\Actions\\Concerns\\AsAction;

class CombatEndTurnAction
{
    use AsAction;
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Http/Requests/CombatEndTurnRequest.php'),
    `<?php

class CombatEndTurnRequest
{
}
`,
  );
  writeFileSync(
    join(projectRoot, 'app/Clients/GameEngineClient.php'),
    `<?php

class GameEngineClient
{
    public function withCanonicalLocation(array $payload): array
    {
        return $payload;
    }
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Pages/Campaign/Turns.vue'),
    `<script setup>
import { useCombatStateMapper } from '@/composables/useCombatStateMapper'
import { useLocality } from '@/composables/useLocality'
import { useTurnResume } from '@/composables/useTurnResume'

const mapper = useCombatStateMapper()
const locality = useLocality()
const resume = useTurnResume()
</script>

<template>
  <LocationHeader :current-location="locality.currentLocation" />
  <aside>
    <li v-for="npc in sidebar.npcs" :key="npc.id">{{ npc.name }}</li>
  </aside>
</template>
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/composables/useCombatStateMapper.ts'),
    `export function useCombatStateMapper() {
  function mapState(payload) {
    return payload.scene_roster ?? payload.visible_npcs
  }

  return { mapState }
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/composables/useLocality.ts'),
    `export function useLocality() {
  const currentLocation = {
    current_location: 'forest',
    display_location: 'Forest',
    world_view: 'surface',
  }

  return { currentLocation }
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/composables/useTurnResume.ts'),
    `export function useTurnResume() {
  return { decision_payload_resolved: true }
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/composables/__tests__/useTurnResume.test.ts'),
    `import { describe, expect, it } from 'vitest'

describe('turn resume', () => {
  it('posts to turns and keeps visible_npcs compatible', () => {
    expect('/turns').toContain('turns')
    expect('visible_npcs').toBe('visible_npcs')
  })
})
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/composables/__tests__/useCharacterCreation.test.ts'),
    `import { describe, expect, it } from 'vitest'

describe('character creation', () => {
  it('mentions world view copy incidentally', () => {
    expect('world_view').toBeTruthy()
  })
})
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Components/DebugPanel.vue'),
    `<template>
  <pre>{{ visible_npcs }}</pre>
</template>
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/Components/LocationHeader.vue'),
    `<script setup>
defineProps({ currentLocation: Object })

function buildSceneSubtitle(location) {
  return location.display_location ?? location.current_location ?? location.world_view
}
</script>

<template>
  <header>{{ buildSceneSubtitle(currentLocation) }}</header>
</template>
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/lang/en.ts'),
    `export default {
  sidebar: {
    npcs: 'NPCs',
  },
}
`,
  );
  writeFileSync(
    join(projectRoot, 'resources/js/types/api.ts'),
    `export interface TurnPayload {
  visible_npcs?: unknown[]
  scene_roster?: unknown[]
  decision_payload_resolved?: boolean
}
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

  it('does not resolve JavaScript member calls to same-name PHP files', async () => {
    const projectRoot = createCrossLanguageCallProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();
      const result = weave.query({
        start: 'resources/js/composables/useSpellPreview.js',
        depth: 2,
      });
      const nodeById = new Map(result.nodes.map(node => [node.id, node] as const));
      const callTargets = result.edges
        .filter(edge => edge.relationship === 'calls')
        .map(edge => nodeById.get(edge.to)?.file)
        .filter((file): file is string => Boolean(file));
      const status = await weave.status();

      expect(callTargets).not.toContain('config/cache.php');
      expect(callTargets).not.toContain('routes/console.php');
      expect(status.diagnostics.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            targetSymbol: 'cache.has',
          }),
        }),
        expect.objectContaining({
          details: expect.objectContaining({
            targetSymbol: 'console.warn',
          }),
        }),
      ]));
    } finally {
      weave.close();
    }
  });

  it('traces non-spec frontend contract terms into concrete implementation files', async () => {
    const projectRoot = createFrontendContractMigrationProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Frontend Vue WorldView display rule. GameEngineClient is background context only. Replace visible_npcs with scene_roster, update sidebar.npcs, current_location, display_location, world_view, buildSceneSubtitle, LocationHeader, currentLocation, DebugPanel.vue, lang/en.ts, Turns.vue, useLocality, useCombatStateMapper, useTurnResume, and useTurnResume.test.ts.',
        maxEntryCandidates: 8,
        maxFiles: 10,
        maxConstraints: 6,
        maxExemplars: 4,
      });
      const workingFiles = payload.workingSet.map(file => file.file);

      expect(payload.entryCandidates[0]?.file).toMatch(/^resources\/js\//);
      expect(payload.entryCandidates[0]?.file).not.toContain('__tests__');
      expect(payload.entryCandidates.map(candidate => candidate.file)).not.toContain('app/Clients/GameEngineClient.php');
      expect(payload.entryCandidates.map(candidate => candidate.file)).not.toContain('resources/js/composables/__tests__/useCharacterCreation.test.ts');
      expect(payload.entryCandidates.some(candidate =>
        candidate.reasons.some(reason => reason.startsWith('task contract term "visible_npcs"')),
      )).toBe(true);
      expect(workingFiles).toEqual(expect.arrayContaining([
        'resources/js/Pages/Campaign/Turns.vue',
        'resources/js/composables/useCombatStateMapper.ts',
        'resources/js/composables/useLocality.ts',
        'resources/js/composables/useTurnResume.ts',
        'resources/js/Components/DebugPanel.vue',
        'resources/js/Components/LocationHeader.vue',
        'resources/js/lang/en.ts',
        'resources/js/types/api.ts',
      ]));
      expect(workingFiles).not.toContain('app/Http/Requests/CombatEndTurnRequest.php');
      expect(workingFiles).not.toContain('app/Clients/GameEngineClient.php');
      expect(workingFiles.indexOf('resources/js/composables/__tests__/useTurnResume.test.ts')).toBeGreaterThan(
        workingFiles.indexOf('resources/js/Pages/Campaign/Turns.vue'),
      );
      expect(payload.constraints.map(constraint => constraint.kind)).not.toEqual(expect.arrayContaining([
        'action',
        'model',
        'form_request',
      ]));
      expect(payload.exemplars.map(exemplar => exemplar.file)).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^app\//),
      ]));
      const validation = weave.validateWithSummary([
        'resources/js/Pages/Campaign/Turns.vue',
        'resources/js/types/api.ts',
      ]);
      expect(validation.evidenceGaps).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Campaign/Turns.vue',
          reason: 'no_indexed_nodes',
        }),
        expect.objectContaining({
          file: 'resources/js/types/api.ts',
          reason: 'unknown_kind',
        }),
      ]));
    } finally {
      weave.close();
    }
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
      expect(weave.exemplar('page')).toEqual(expect.objectContaining({
        file: expect.stringMatching(/^resources\/js\/Pages\/.+\.vue$/),
      }));
      expect(weave.exemplar('action', undefined, { routeMethod: 'GET' })).toEqual(expect.objectContaining({
        file: expect.stringMatching(/^app\/Actions\/(?:Auth\/ShowLoginPageAction|Admin\/ShowHookCreatePageAction)\.php$/),
      }));
      const routeImpact = weave.impact('routes/web.php', { summary: true });
      expect(routeImpact.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Actions/Auth/ShowLoginPageAction.php',
        }),
      ]));
      expect(routeImpact.edges.some(edge => edge.relationship === 'routes_to')).toBe(true);
      const layoutImpact = weave.impact('resources/js/Pages/Layout.vue', { summary: true });
      expect(layoutImpact.impact?.crossFileNodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Auth/Login.vue',
        }),
      ]));
      const validation = weave.validateWithSummary([
        'app/Actions/Auth/ShowLoginPageAction.php',
      ]);
      expect(validation.summary.message).toContain('all pass');
      expect(validation.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Actions/Auth/ShowLoginPageAction.php',
          kind: 'action',
          status: 'pass',
        }),
      ]));
      const plannedValidation = weave.validateWithSummary([
        'app/Actions/Auth/ShowRegisterPageAction.php',
      ]);
      expect(plannedValidation.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Actions/Auth/ShowRegisterPageAction.php',
          kind: 'action',
          predictive: true,
        }),
      ]));
      expect(plannedValidation.summary.message).toContain('pending graph-dependent');
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
      const worktreeValidation = weave.validateWithSummary([]);
      expect(worktreeValidation.summary.source).toBe('git_uncommitted');
      expect(worktreeValidation.worktree).toEqual(expect.objectContaining({
        source: 'git_uncommitted',
        checkedFiles: expect.arrayContaining([
          'app/Actions/Auth/ShowLoginPageAction.php',
        ]),
        changedFiles: expect.arrayContaining([
          'app/Actions/Auth/ShowLoginPageAction.php',
        ]),
      }));
      expect(worktreeValidation.worktree?.checkedFiles.some(file => file.startsWith('.weave/'))).toBe(false);
      expect(worktreeValidation.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Actions/Auth/ShowLoginPageAction.php',
          kind: 'action',
        }),
      ]));
      execFileSync('git', ['add', 'app/Actions/Auth/ShowLoginPageAction.php'], { cwd: projectRoot, stdio: 'ignore' });
      const stagedValidation = weave.validateWithSummary([], { stagedOnly: true });
      expect(stagedValidation.summary.source).toBe('git_staged');
      expect(stagedValidation.worktree).toEqual(expect.objectContaining({
        source: 'git_staged',
        checkedFiles: expect.arrayContaining([
          'app/Actions/Auth/ShowLoginPageAction.php',
        ]),
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

  it('fails soft to summary mode for oversized impact results', async () => {
    const projectRoot = createHighFanoutImpactProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const impact = weave.impact('src/shared/hub.js');
      expect(impact.impact?.totalCounts?.crossFileNodes).toBeGreaterThan(30);
      expect(impact.impact?.budget).toEqual(expect.objectContaining({
        summary: true,
        autoSummarized: true,
      }));
      expect(JSON.stringify(impact).length).toBeLessThan(24_000);
    } finally {
      weave.close();
    }
  });

  it('rebuilds during refresh when the stored indexer fingerprint is stale', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();
      const fingerprintPath = join(projectRoot, '.weave', 'index-fingerprint.json');
      const initial = JSON.parse(readFileSync(fingerprintPath, 'utf-8')) as { hash: string };
      writeFileSync(fingerprintPath, `${JSON.stringify({
        version: 0,
        hash: 'stale-indexer',
        plugins: [],
        generatedAt: '2000-01-01T00:00:00.000Z',
      }, null, 2)}\n`);

      const refresh = await weave.refresh();
      const refreshed = JSON.parse(readFileSync(fingerprintPath, 'utf-8')) as { hash: string };

      expect(refresh.initialized).toBe(true);
      expect(refreshed.hash).toBe(initial.hash);
    } finally {
      weave.close();
    }
  });

  it('indexes markdown specs and lets bootstrap seed context from referenced files', async () => {
    const projectRoot = createSpecSeedProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const specResult = weave.query({
        start: 'docs/LORE_FEATURE_DESIGN.md',
        depth: 0,
      });
      expect(specResult.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'docs/LORE_FEATURE_DESIGN.md',
          kind: 'spec',
        }),
      ]));

      const payload = weave.bootstrap({
        task: 'Build the lore codex feature described in the design doc',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        maxFiles: 6,
        maxEntryCandidates: 5,
      });
      const verbosePayload = weave.bootstrap({
        task: 'Build the lore codex feature described in the design doc',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        compact: false,
        maxFiles: 6,
        maxEntryCandidates: 5,
      });
      expect(verbosePayload.spec?.likelyNewFileExemplars).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Actions/Lore/DiscoverLoreAction.php',
          kind: 'action',
          exemplarFile: null,
          reason: expect.stringContaining('No reliable exemplar'),
        }),
      ]));
      const compactBytes = Buffer.byteLength(JSON.stringify(payload));
      const verboseBytes = Buffer.byteLength(JSON.stringify(verbosePayload));
      expect(compactBytes).toBeLessThan(verboseBytes);
      expect(compactBytes).toBeLessThan(20_000);
      expect(JSON.parse(JSON.stringify(payload))).toEqual(expect.objectContaining({
        workingSet: expect.any(Array),
        constraints: expect.any(Array),
        exemplars: expect.any(Array),
      }));
      expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('context');

      expect(payload.spec).toEqual(expect.objectContaining({
        file: 'docs/LORE_FEATURE_DESIGN.md',
        existingFiles: expect.arrayContaining([
          'resources/js/Pages/Orders/Status.vue',
          'resources/js/Components/UI/InfoTooltip.vue',
          'resources/js/composables/useOrderEvents.js',
          'routes/web.php',
        ]),
        suspiciousReferences: expect.arrayContaining([
          'index.php',
        ]),
      }));
      expect(payload.spec?.suspiciousReferences).not.toContain('the_unmaking.php');
      expect(payload.spec?.existingFiles).not.toContain('public/index.php');
      expect(payload.entryCandidates.map(candidate => candidate.file)).not.toContain('public/index.php');
      expect(payload.spec).toEqual(expect.objectContaining({
        missingFiles: expect.arrayContaining([
          'app/Actions/Lore/DiscoverLoreAction.php',
          'database/migrations/2026_01_01_000000_create_discovered_lore_table.php',
          'tests/Feature/LoreRegistryTest.php',
          'resources/js/Pages/Lore/Index.vue',
          'resources/js/Components/Lore/LoreText.vue',
          'resources/js/Components/LoreTerm.vue',
          'config/lore/the_unmaking.php',
          'config/lore/cosmology/the_unmaking.php',
          'config/lore/cosmology/the_veil.php',
          'config/lore/cosmology/iron_concord.php',
        ]),
        likelyNewFiles: expect.arrayContaining([
          'app/Actions/Lore/DiscoverLoreAction.php',
          'database/migrations/2026_01_01_000000_create_discovered_lore_table.php',
          'tests/Feature/LoreRegistryTest.php',
          'resources/js/Pages/Lore/Index.vue',
          'resources/js/Components/Lore/LoreText.vue',
          'resources/js/Components/LoreTerm.vue',
          'config/lore/the_unmaking.php',
          'config/lore/cosmology/the_unmaking.php',
          'config/lore/cosmology/the_veil.php',
          'config/lore/cosmology/iron_concord.php',
        ]),
        plannedFiles: expect.arrayContaining([
          'app/Services/LoreRegistry.php',
          'app/Actions/Lore/DiscoverLoreAction.php',
          'resources/js/Pages/Lore/Index.vue',
        ]),
        existingTargets: expect.arrayContaining([
          'resources/js/Pages/Orders/Status.vue',
          'app/Actions/Orders/ShowOrderStatusAction.php',
        ]),
        staleSpecRefs: expect.arrayContaining([
          'index.php',
        ]),
        novelPathPrefixes: expect.arrayContaining([
          'resources/js/Pages/Lore',
          'config/lore',
        ]),
      }));
      expect(payload.spec?.referencedFiles).not.toContain('Three.js');
      expect(payload.spec?.likelyNewFiles).not.toContain('resources/js/Components/LoreText.vue');
      expect(payload.spec?.suspiciousReferences).not.toContain('the_veil.php');
      expect(payload.entryCandidates.map(candidate => candidate.file)).toEqual(expect.arrayContaining([
        'resources/js/Pages/Orders/Status.vue',
        'resources/js/Components/UI/InfoTooltip.vue',
        'resources/js/composables/useOrderEvents.js',
      ]));
      expect(payload.entryCandidates[0]).toEqual(expect.objectContaining({
        file: 'resources/js/Pages/Orders/Status.vue',
        confidence: 0.99,
      }));
      expect(payload.spec?.lineReferences).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Orders/Status.vue',
          lineStart: 4,
          lineEnd: 5,
        }),
      ]));
      expect(payload.spec?.lineAnchoredQueries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Orders/Status.vue',
          query: 'resources/js/Pages/Orders/Status.vue:4-5',
        }),
      ]));
      expect(verbosePayload.spec?.existingFileEdges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Actions/Orders/ShowOrderStatusAction.php',
          edges: expect.arrayContaining([
            expect.objectContaining({
              direction: 'incoming',
              relationship: 'routes_to',
              sourceFile: 'routes/web.php',
              metadata: expect.objectContaining({
                path: '/orders/{order}',
              }),
            }),
            expect.objectContaining({
              direction: 'outgoing',
              relationship: 'renders',
              targetFile: 'resources/js/Pages/Orders/Status.vue',
              metadata: expect.objectContaining({
                props: expect.arrayContaining(['order']),
              }),
            }),
          ]),
        }),
      ]));
      expect(verbosePayload.spec?.likelyNewFileExemplars).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Services/LoreRegistry.php',
          kind: 'service',
          exemplarFile: null,
          confidence: 0.35,
        }),
        expect.objectContaining({
          file: 'app/Actions/Lore/DiscoverLoreAction.php',
          kind: 'action',
        }),
        expect.objectContaining({
          file: 'config/lore/cosmology/the_unmaking.php',
          kind: 'config_array',
          exemplarFile: null,
          confidence: 0.35,
        }),
        expect.objectContaining({
          file: 'tests/Feature/LoreRegistryTest.php',
          kind: 'test',
          exemplarFile: expect.stringMatching(/^tests\/Feature\/(?:OrderStatus|OrderEvents)Test\.php$/),
        }),
        expect.objectContaining({
          file: 'resources/js/composables/useLoreMatcher.js',
          kind: 'composable',
          exemplarFile: null,
          reason: expect.stringContaining('No reliable exemplar'),
        }),
      ]));
      const matcherExemplar = verbosePayload.spec?.likelyNewFileExemplars?.find(exemplar =>
        exemplar.file === 'resources/js/composables/useLoreMatcher.js'
      );
      expect(matcherExemplar?.confidence ?? 1).toBeLessThan(0.6);
      const impliedTestPayload = weave.bootstrap({
        task: 'Implement the lore registry and discovery action',
        fromSpecText: `# Lore Registry

Edit \`resources/js/Pages/Orders/Status.vue\`.

Add tests for registry validation and discovery action behavior.
`,
        maxExemplars: 8,
      });
      expect(impliedTestPayload.spec?.likelyNewFiles).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^tests\//),
      ]));
      expect(impliedTestPayload.context.exemplars).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'test',
          file: expect.stringMatching(/^tests\/Feature\/(?:OrderStatus|OrderEvents)Test\.php$/),
          reason: expect.stringContaining('Spec mentions tests'),
        }),
      ]));
      const specAwareImpact = weave.impact('resources/js/composables/useOrderEvents.js', {
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        includeSpecContext: false,
      });
      expect(specAwareImpact).not.toHaveProperty('specContext');
      expect(specAwareImpact.impact?.specTouchpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Orders/Status.vue',
          status: 'spec_related_not_impacted',
          lineStart: 4,
          lineEnd: 5,
        }),
      ]));
      const localContext = weave.context({
        start: 'resources/js/Components/UI/InfoTooltip.vue',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        maxFiles: 4,
      });
      expect(localContext.workingSet.map(file => file.file)).not.toContain('app/Actions/Orders/ShowOrderStatusAction.php');
      const specValidation = weave.validateWithSummary([
        'resources/js/Pages/Orders/Status.vue',
        'app/Actions/Orders/ShowOrderStatusAction.php',
      ], {
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
      });
      expect(specValidation.specCoverage).toEqual(expect.objectContaining({
        file: 'docs/LORE_FEATURE_DESIGN.md',
        checkedExpectedFiles: expect.arrayContaining([
          'resources/js/Pages/Orders/Status.vue',
          'app/Actions/Orders/ShowOrderStatusAction.php',
        ]),
        uncheckedExpectedFiles: expect.arrayContaining([
          'app/Services/LoreRegistry.php',
          'app/Actions/Lore/DiscoverLoreAction.php',
        ]),
        missingExpectedFiles: expect.arrayContaining([
          'app/Services/LoreRegistry.php',
          'app/Actions/Lore/DiscoverLoreAction.php',
        ]),
      }));
      expect(specValidation.specCoverage?.message).toContain('Create missing planned files');
      expect(verbosePayload.spec?.plannedFilePatterns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Services/LoreRegistry.php',
          kind: 'service',
          role: expect.objectContaining({
            primary: 'registry',
          }),
          directExemplarFile: null,
          status: expect.stringMatching(/^(adjacent_evidence|evidence_gap)$/),
          configPatterns: expect.arrayContaining([
            expect.objectContaining({
              pattern: 'config_array_files',
              files: expect.arrayContaining(['config/app.php']),
            }),
          ]),
          notes: expect.arrayContaining([
            expect.stringContaining('No role-compatible registry exemplar found'),
          ]),
        }),
      ]));
      expect(payload.context.workingSet.map(file => file.file)).toEqual(expect.arrayContaining([
        'docs/LORE_FEATURE_DESIGN.md',
        'resources/js/Pages/Orders/Status.vue',
        'resources/js/Components/UI/InfoTooltip.vue',
        'resources/js/composables/useOrderEvents.js',
        'routes/web.php',
      ]));
      expect(payload.context.workingSet).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Orders/Status.vue',
          kind: 'inertia_page',
          kinds: expect.arrayContaining(['component', 'inertia_page']),
        }),
      ]));
      expect(payload.context.constraints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'component',
          plugin: 'vue-composition',
        }),
      ]));
      expect(payload.context.workingSet.slice(0, 5).map(file => file.file)).toEqual(expect.arrayContaining([
        'resources/js/Pages/Orders/Status.vue',
        'resources/js/Components/UI/InfoTooltip.vue',
        'resources/js/composables/useOrderEvents.js',
      ]));
      expect(weave.exemplar('component', undefined, { subKind: 'leaf' })).toEqual(expect.objectContaining({
        file: 'resources/js/Components/Alerts.vue',
      }));
      expect(weave.conventions('component')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          property: 'has <template> block',
          confidence: 1,
        }),
      ]));
      expect(weave.conventions('composable')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          property: 'returns an object API',
          confidence: 1,
        }),
      ]));
      const lineRangeQuery = weave.query({
        start: 'resources/js/Pages/Orders/Status.vue:4-5',
        depth: 0,
        options: { includeSnippets: true, maxTokens: 300 },
      });
      expect(lineRangeQuery.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Orders/Status.vue',
          kind: 'vue_template',
          snippetLines: expect.arrayContaining([expect.any(Number), expect.any(Number)]),
          snippet: expect.stringContaining('lore-anchor'),
        }),
      ]));
      const defaultLineRangeQuery = weave.query({
        start: 'resources/js/Pages/Orders/Status.vue:4-5',
        options: { includeSnippets: true, maxTokens: 3000 },
      });
      expect(defaultLineRangeQuery.nodes.length).toBeLessThanOrEqual(2);
      expect(defaultLineRangeQuery.edges).toEqual([]);
      expect(defaultLineRangeQuery.budget?.omittedEdges).toBe(0);
      expect(defaultLineRangeQuery.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Orders/Status.vue',
          kind: 'vue_template',
          lines: [1, 87],
          snippetLines: [1, 35],
          snippet: expect.stringContaining('lore-anchor'),
        }),
      ]));
      expect(defaultLineRangeQuery.nodes.some(node => node.kind === 'component')).toBe(false);
      const lineRangeImpact = weave.impact('resources/js/Pages/Orders/Status.vue', {
        lineStart: 4,
        lineEnd: 5,
        summary: true,
        maxTokens: 300,
      });
      expect(lineRangeImpact.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Pages/Orders/Status.vue',
          kind: 'vue_template',
        }),
      ]));
      expect(lineRangeImpact.nodes.some(node => node.kind === 'component')).toBe(true);
      expect(lineRangeImpact.impact?.targetFiles).toContain('resources/js/Pages/Orders/Status.vue');
      expect(payload.workingSet).toBe(payload.context.workingSet);
      expect(payload.constraints).toBe(payload.context.constraints);
      expect(payload.exemplars).toBe(payload.context.exemplars);
      expect(payload.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'novel_path_prefixes',
          files: expect.arrayContaining(['config/lore']),
        }),
        expect.objectContaining({
          code: 'planned_file_evidence_gaps',
          details: expect.objectContaining({
            gaps: expect.arrayContaining([
              expect.objectContaining({
                file: 'app/Services/LoreRegistry.php',
                issues: expect.arrayContaining([
                  'no indexed exemplar',
                ]),
              }),
              expect.objectContaining({
                file: 'database/migrations/2026_01_01_000000_create_discovered_lore_table.php',
                issues: expect.arrayContaining([
                  'no indexed exemplar',
                ]),
              }),
              expect.objectContaining({
                file: 'config/lore/the_unmaking.php',
                issues: expect.arrayContaining([
                  'no indexed exemplar',
                ]),
              }),
            ]),
          }),
        }),
      ]));
      const plannedFiles = payload.spec?.plannedFiles ?? [];
      const plannedFilesWithExemplars = new Set((payload.spec?.likelyNewFileExemplars ?? []).map(exemplar => exemplar.file));
      const plannedEvidenceGaps = new Set(
        (((payload.warnings ?? []).find(warning => warning.code === 'planned_file_evidence_gaps')?.details?.gaps ?? []) as Array<{ file: string }>)
          .map(gap => gap.file),
      );
      expect(plannedFiles.length).toBeGreaterThan(0);
      for (const file of plannedFiles) {
        expect(
          plannedFilesWithExemplars.has(file) || plannedEvidenceGaps.has(file),
          `${file} should have an exemplar or an explicit evidence-gap warning`,
        ).toBe(true);
      }
      expect(payload.context.workingSet.every(file => file.reasons.length > 0)).toBe(true);
      expect(payload.context.workingSet.find(file =>
        file.file === 'routes/web.php'
      )).toEqual(expect.objectContaining({
        confidence: expect.any(Number),
      }));
      expect(payload.context.workingSet.find(file =>
        file.file === 'routes/web.php'
      )?.confidence ?? 0).toBeGreaterThanOrEqual(0.9);

      const compactPayload = weave.bootstrap({
        task: 'Build lore discovery highlights from the design spec',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        compact: true,
        maxFiles: 6,
        maxEntryCandidates: 5,
        maxExemplars: 5,
      });
      expect(compactPayload.context.exemplars.length).toBeGreaterThan(0);
      expect(compactPayload.context.exemplars.length).toBeLessThanOrEqual(5);
      expect(compactPayload.context.exemplars).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provenance: 'spec_planned_file',
          plannedFile: expect.any(String),
        }),
      ]));
      expect(compactPayload.spec?.likelyNewFileExemplars?.length).toBeGreaterThanOrEqual(5);
      expect(compactPayload.spec?.likelyNewFileExemplars).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Services/LoreRegistry.php',
          exemplarFile: null,
        }),
      ]));
      expect(compactPayload.spec?.existingFiles.length).toBeLessThanOrEqual(6);
      expect(compactPayload.prompt).toContain('spec.likelyNewFileExemplars');
      expect(compactPayload.context.workingSet.every(file =>
        file.reasons.length <= 3 && file.anchors.length <= 2
      )).toBe(true);

      expect(verbosePayload.spec?.likelyNewFileExemplars).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/Components/Lore/LoreText.vue',
          exemplarFile: 'resources/js/Components/UI/InfoTooltip.vue',
          reason: expect.stringContaining('co-mentioned'),
        }),
        expect.objectContaining({
          file: 'app/Actions/Lore/DiscoverLoreAction.php',
          kind: 'action',
        }),
      ]));

      const missingQuery = weave.query({
        start: 'config/lore/index.php',
      });
      expect(missingQuery).toEqual(expect.objectContaining({
        nodes: [],
        edges: [],
        resolution: expect.objectContaining({
          file: 'config/lore/index.php',
          status: 'missing_file',
        }),
      }));

      const autoSpecPayload = weave.bootstrap({
        task: 'Implement the feature in docs/LORE_FEATURE_DESIGN.md',
        maxFiles: 6,
        maxEntryCandidates: 5,
      });
      expect(autoSpecPayload.spec?.file).toBe('docs/LORE_FEATURE_DESIGN.md');
      expect(autoSpecPayload.entryCandidates.map(candidate => candidate.file)).toEqual(expect.arrayContaining([
        'resources/js/Pages/Orders/Status.vue',
        'resources/js/composables/useOrderEvents.js',
      ]));

      const specAwareQuery = weave.query({
        start: 'resources/js/composables/useOrderEvents.js',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        task: 'Implement the lore feature from the spec',
      });
      expect(specAwareQuery.specContext).toEqual(expect.objectContaining({
        file: 'docs/LORE_FEATURE_DESIGN.md',
        mode: 'summary',
        relatedExistingFiles: expect.arrayContaining([
          'resources/js/Pages/Orders/Status.vue',
          'resources/js/composables/useOrderEvents.js',
        ]),
        plannedFiles: expect.arrayContaining([
          'resources/js/Pages/Lore/Index.vue',
        ]),
        likelyNewFileExemplars: [],
        plannedFileExemplarRefs: expect.arrayContaining([
          expect.objectContaining({
            file: 'resources/js/Pages/Lore/Index.vue',
            exemplarFile: expect.any(String),
          }),
        ]),
        plannedFilePatternRefs: expect.any(Array),
      }));

      const alignedPayload = weave.bootstrap({
        task: 'Build Laravel LoreRegistry discovery highlights segment-aware typewriter',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        maxFiles: 4,
      });
      expect(alignedPayload.warnings?.some(warning =>
        warning.code === 'spec_task_term_mismatch'
      )).toBe(false);
      const integrationPayload = weave.bootstrap({
        task: 'Integrate lore highlights into the typewriter',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        maxFiles: 4,
      });
      expect(integrationPayload.warnings?.some(warning =>
        warning.code === 'spec_task_term_mismatch'
      )).toBe(false);

      const noSpecPayload = weave.bootstrap({
        task: 'Build per-player controls for the players page',
        maxEntryCandidates: 5,
        maxFiles: 4,
      });
      expect(noSpecPayload.entryCandidates.map(candidate => candidate.file)).toContain('resources/js/Pages/Players/Show.vue');
      expect(noSpecPayload.entryCandidates.map(candidate => candidate.file)).not.toContain('resources/js/composables/usePerformanceTier.js');
      expect(noSpecPayload.entryCandidates.map(candidate => candidate.file)).not.toContain('app/Actions/Admin/ImpersonateUserAction.php');

      const mismatchedPayload = weave.bootstrap({
        task: 'Build lore CRUD with tags, search, and visibility filters',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        maxFiles: 4,
      });
      expect(mismatchedPayload.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'spec_task_term_mismatch',
          terms: expect.arrayContaining(['crud', 'tags', 'search']),
        }),
      ]));
      const pronounPayload = weave.bootstrap({
        task: 'Build lore for them and other entity references',
        fromSpec: 'docs/LORE_FEATURE_DESIGN.md',
        maxFiles: 4,
      });
      const pronounMismatch = pronounPayload.warnings?.find(warning =>
        warning.code === 'spec_task_term_mismatch'
      );
      expect(pronounMismatch?.terms ?? []).not.toEqual(expect.arrayContaining(['them', 'other']));
      expect(pronounMismatch?.terms ?? []).toEqual(expect.arrayContaining(['entity']));

      const inlinePayload = weave.bootstrap({
        task: 'Build the inline lore UI notes',
        fromSpecText: `# Inline Lore Notes

Use \`InfoTooltip.vue\` and add \`Pages/Lore/Index.vue\`.
`,
        maxFiles: 3,
      });
      expect(inlinePayload.spec).toEqual(expect.objectContaining({
        file: '<inline-spec>',
        existingFiles: expect.arrayContaining([
          'resources/js/Components/UI/InfoTooltip.vue',
        ]),
        likelyNewFiles: expect.arrayContaining([
          'resources/js/Pages/Lore/Index.vue',
        ]),
      }));
    } finally {
      weave.close();
    }
  });

  it('indexes Laravel model, migration, FormRequest, service, and config kinds for conventions and exemplars', async () => {
    const projectRoot = createLaravelKindProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      expect(weave.query({ start: 'app/Models/Post.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'model', symbol: 'Post' }),
      ]));
      expect(weave.query({ start: 'app/Enums/PostStatus.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'enum', symbol: 'PostStatus' }),
      ]));
      expect(weave.query({ start: 'app/Support/PublishesPosts.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'trait', symbol: 'PublishesPosts' }),
      ]));
      expect(weave.query({ start: 'database/migrations/2026_01_01_000000_create_posts_table.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'migration' }),
      ]));
      expect(weave.query({ start: 'app/Http/Requests/StorePostRequest.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'form_request', symbol: 'StorePostRequest' }),
      ]));
      expect(weave.query({ start: 'app/Services/PostPublisher.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'service', symbol: 'PostPublisher' }),
      ]));
      expect(weave.query({ start: 'app/Clients/PublishingApiClient.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'service', symbol: 'PublishingApiClient' }),
      ]));
      expect(weave.query({ start: 'config/lore/index.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'config_array', symbol: 'index' }),
      ]));
      expect(weave.query({ start: 'tests/Feature/PostTest.php', depth: 0 }).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'test', symbol: 'PostTest' }),
      ]));

      expect(weave.exemplar('model')).toEqual(expect.objectContaining({
        file: expect.stringMatching(/^app\/Models\/(?:Post|Comment)\.php$/),
      }));
      expect(weave.exemplar('migration')).toEqual(expect.objectContaining({
        file: expect.stringMatching(/^database\/migrations\/2026_01_01_00000[01]_create_(?:posts|comments)_table\.php$/),
      }));
      expect(weave.exemplar('service')).toEqual(expect.objectContaining({
        file: expect.stringMatching(/^app\/(?:Services\/(?:PostPublisher|PostDigestBuilder)|Clients\/PublishingApiClient)\.php$/),
      }));
      expect(weave.exemplar('config_array')).toEqual(expect.objectContaining({
        file: expect.stringMatching(/^config\/lore\/(?:index|cosmology)\.php$/),
      }));
      expect(weave.exemplar('test')).toEqual(expect.objectContaining({
        file: expect.stringMatching(/^tests\/Feature\/(?:Post|Comment)Test\.php$/),
      }));
      expect(weave.conventions('request').map(convention => convention.kind)).toEqual(expect.arrayContaining([
        'form_request',
      ]));
      expect(weave.conventions('test')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'test',
          property: 'located in tests/Feature/',
        }),
      ]));
      const diagnostics = await weave.status();
      const issueTargets = diagnostics.diagnostics.issues
        .map(issue => issue.details as Record<string, unknown> | null)
        .map(details => details?.targetSymbol ?? details?.importedSymbol ?? details?.resolvedTo)
        .filter(Boolean);
      expect(issueTargets).not.toEqual(expect.arrayContaining([
        'Post::query',
        'Str::uuid',
        'App\\Enums\\PostStatus',
        'App\\Support\\PublishesPosts',
      ]));

      const serviceSpecPayload = weave.bootstrap({
        task: 'Add a report digest builder service',
        fromSpecText: 'Create `app/Services/ReportDigestBuilder.php`.',
        maxFiles: 3,
      });
      expect(serviceSpecPayload.spec?.plannedFilePatterns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Services/ReportDigestBuilder.php',
          role: expect.objectContaining({
            primary: 'builder',
          }),
          status: 'direct_exemplar',
          directExemplarFile: 'app/Services/PostDigestBuilder.php',
        }),
      ]));

      const plannedServiceValidation = weave.validateWithSummary([
        'app/Services/ReportRegistry.php',
      ]);
      expect(plannedServiceValidation.violations).toEqual([]);
      expect(plannedServiceValidation.summary.evidenceGaps).toBeGreaterThanOrEqual(1);
      expect(plannedServiceValidation.summary.message).toContain('lacked enforceable pattern evidence');
      expect(plannedServiceValidation.evidenceGaps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'app/Services/ReportRegistry.php',
          kind: 'service',
          reason: 'no_high_confidence_conventions',
        }),
      ]));
    } finally {
      weave.close();
    }
  });

  it('classifies external framework/plugin endpoint misses separately from internal graph gaps', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();
      const status = await weave.status();
      const usePageIssues = status.diagnostics.issues.filter(issue =>
        issue.rule === 'composable-usage'
        && (issue.details as Record<string, unknown> | null)?.resolvedTo === 'usePage'
      );

      expect(usePageIssues.length).toBeGreaterThan(0);
      expect(usePageIssues.every(issue => issue.classification === 'external_dependency')).toBe(true);
      expect(status.diagnostics.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          rule: 'composable-usage',
          classification: 'internal_unresolved',
          details: expect.objectContaining({ resolvedTo: 'usePage' }),
        }),
      ]));
    } finally {
      weave.close();
    }
  });

  it('honors inertia_page subKind when selecting page exemplars', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'weave-inertia-subkind-'));
    createdProjects.push(projectRoot);

    mkdirSync(join(projectRoot, 'resources/js/Pages/Reports'), { recursive: true });
    mkdirSync(join(projectRoot, 'app/Actions/Reports'), { recursive: true });
    writeFileSync(join(projectRoot, 'artisan'), '#!/usr/bin/env php\n');
    writeFileSync(
      join(projectRoot, 'composer.json'),
      JSON.stringify({ require: { 'inertiajs/inertia-laravel': '^1.0' } }, null, 2),
    );
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.0.0', '@inertiajs/vue3': '^1.0.0' } }, null, 2),
    );
    writeFileSync(
      join(projectRoot, 'resources/js/Pages/Reports/Index.vue'),
      `<template>
  <table>
    <tr v-for="report in reports" :key="report.id">
      <td>{{ report.name }}</td>
    </tr>
  </table>
</template>
`,
    );
    writeFileSync(
      join(projectRoot, 'resources/js/Pages/Reports/Show.vue'),
      `<script setup>
defineProps({ report: Object })
</script>

<template>
  <article>{{ report.name }}</article>
</template>
`,
    );
    writeFileSync(
      join(projectRoot, 'app/Actions/Reports/ListReportsAction.php'),
      `<?php

namespace App\\Actions\\Reports;

use Inertia\\Inertia;

class ListReportsAction
{
    public function asController(): mixed
    {
        return Inertia::render('Reports/Index');
    }
}
`,
    );
    writeFileSync(
      join(projectRoot, 'app/Actions/Reports/ShowReportAction.php'),
      `<?php

namespace App\\Actions\\Reports;

use Inertia\\Inertia;

class ShowReportAction
{
    public function asController(): mixed
    {
        return Inertia::render('Reports/Show');
    }
}
`,
    );

    const weave = new Weave(projectRoot);
    try {
      await weave.init();
      expect(weave.exemplar('inertia_page', undefined, { subKind: 'index' })).toEqual(expect.objectContaining({
        file: 'resources/js/Pages/Reports/Index.vue',
      }));
      expect(weave.exemplar('inertia_page', undefined, { subKind: 'show' })).toEqual(expect.objectContaining({
        file: 'resources/js/Pages/Reports/Show.vue',
      }));
    } finally {
      weave.close();
    }
  });

  it('warns when project instructions require tests but a creation spec omits them', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'weave-project-test-guidance-'));
    createdProjects.push(projectRoot);

    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    mkdirSync(join(projectRoot, 'resources/js/Pages'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'AGENTS.md'),
      'New feature work must include PHPUnit or Vitest coverage when behavior changes.\n',
    );
    writeFileSync(
      join(projectRoot, 'docs/FEATURE.md'),
      'Add `resources/js/Pages/Home.vue` and wire the feature.',
    );
    writeFileSync(
      join(projectRoot, 'resources/js/Pages/Home.vue'),
      '<template><div>Home</div></template>\n',
    );

    const weave = new Weave(projectRoot);
    try {
      await weave.init();
      const payload = weave.bootstrap({
        task: 'Implement the home feature',
        fromSpec: 'docs/FEATURE.md',
      });

      expect(payload.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'project_test_guidance',
          files: ['AGENTS.md'],
        }),
      ]));
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

  it('marks greenfield bootstrap candidates as weak fallback when dominant task terms have no graph evidence', async () => {
    const projectRoot = createFixtureProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Build a lore codex archive for player discoveries',
        maxFiles: 4,
      });

      expect(payload.entryCandidates.length).toBeGreaterThan(0);
      expect(payload.entryCandidates.every(candidate => candidate.confidence <= 0.35)).toBe(true);
      expect(payload.entryCandidates.every(candidate =>
        candidate.reasons.includes('weak fallback: no strong graph evidence for dominant task terms')
      )).toBe(true);
      expect(payload.guidance).toEqual(expect.arrayContaining([
        expect.stringContaining('No strong graph evidence matched the dominant task terms'),
      ]));
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
        task: 'Audit the communication architecture around payment service order processing, realtime events, polling, and keepalive behavior',
        start: 'app/Clients/PaymentGatewayClient.php',
        depth: 2,
        maxFiles: 12,
        maxConstraints: 6,
        maxExemplars: 3,
      });

      expect(payload.taskMode).toBe('audit_communication');
      expect(payload.entryCandidates.map(candidate => candidate.file)).toEqual(expect.arrayContaining([
        'app/Clients/PaymentGatewayClient.php',
        'app/Actions/Orders/Processing/CreateOrderProcessingAction.php',
        'app/Actions/Orders/Events/StreamOrderEventsAction.php',
        'resources/js/Pages/Orders/Status.vue',
      ]));
      expect(payload.entryCandidates.some(candidate => candidate.file === 'app/Actions/Admin/ListOrderEventsAction.php')).toBe(false);
      expect(payload.entryCandidates.some(candidate => candidate.file === 'app/Actions/Orders/Processing/ListOrderProcessingRunsAction.php')).toBe(false);

      const workingFiles = payload.context.workingSet.map(file => file.file);
      expect(workingFiles).toEqual(expect.arrayContaining([
        'app/Actions/Orders/Processing/CreateOrderProcessingAction.php',
        'app/Actions/Orders/Events/StreamOrderEventsAction.php',
        'resources/js/Pages/Orders/Status.vue',
        'resources/js/composables/useOrderEvents.js',
        'resources/js/composables/useOrderPolling.js',
        'resources/js/composables/usePaymentStatus.js',
        'resources/js/Scripts/api.js',
        'config/services.php',
      ]));
      expect(workingFiles.some(file => file.startsWith('tests/'))).toBe(false);
      expect(workingFiles).not.toContain('app/Actions/Admin/ListOrderEventsAction.php');
      expect(workingFiles).not.toContain('app/Actions/Orders/Processing/ListOrderProcessingRunsAction.php');
      expect(payload.context.workingSet.some(file =>
        file.file === 'config/services.php'
      )).toBe(true);
      expect(weave.conventions('composable')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'composable',
          property: 'matches naming pattern use{Name}',
          confidence: 1,
        }),
        expect.objectContaining({
          kind: 'composable',
          property: 'located in resources/js/composables/',
          confidence: 1,
        }),
      ]));

      const validation = weave.validateWithSummary([
        'resources/js/composables/useOrderEvents.js',
      ]);
      expect(validation.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/composables/useOrderEvents.js',
          kind: 'composable',
          rule: 'matches naming pattern use{Name}',
          status: 'pass',
        }),
      ]));
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
      const validation = weave.validateWithSummary([
        'resources/js/composables/useWeatherIntensity.js',
        'app/Http/Middleware/HandleInertiaRequests.php',
      ]);
      expect(validation.violations).toEqual([]);
      expect(validation.summary.message).toContain('lacked enforceable pattern evidence');
      expect(validation.evidenceGaps?.length).toBeGreaterThan(0);
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

      const impact = weave.impact('resources/js/Components/Game/DebugPanel.vue');
      expect(impact.impact).toEqual(expect.objectContaining({
        targetFiles: ['resources/js/Components/Game/DebugPanel.vue'],
        counts: expect.objectContaining({
          crossFileNodes: expect.any(Number),
          crossFileEdges: expect.any(Number),
          intraFileEdges: expect.any(Number),
        }),
      }));
      expect(impact.impact?.crossFileNodes.some(node =>
        node.file === 'resources/js/Pages/Campaign/Turns.vue'
      )).toBe(true);
      const summarizedImpact = weave.impact('resources/js/Components/Game/DebugPanel.vue', {
        summary: true,
        maxTokens: 600,
      });
      expect(summarizedImpact.impact?.budget).toEqual(expect.objectContaining({
        summary: true,
        maxTokens: 600,
      }));
      const kindBreakdown = Object.values(summarizedImpact.impact?.kindBreakdown ?? {});
      expect(kindBreakdown.some((entry) =>
        typeof entry.shown === 'number' && typeof entry.total === 'number',
      )).toBe(true);
      expect(summarizedImpact.impact?.topFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: expect.any(String),
          edgeCount: expect.any(Number),
          relationships: expect.any(Object),
        }),
      ]));
      const taskRankedImpact = weave.impact('resources/js/Pages/Campaign/Turns.vue', {
        summary: true,
        task: 'Add dice roll controls',
      });
      expect(taskRankedImpact.impact?.topFiles?.slice(0, 3).some(file =>
        /dice/i.test(file.file),
      )).toBe(true);
      expect(summarizedImpact.edges.length).toBeLessThanOrEqual(summarizedImpact.impact?.budget?.maxEdges ?? 0);
    } finally {
      weave.close();
    }
  });

  it('uses endpoint literals to surface frontend HTTP callers instead of generic action-path noise', async () => {
    const projectRoot = createFrontendEndpointProject();
    createdProjects.push(projectRoot);

    const weave = new Weave(projectRoot);
    try {
      await weave.init();

      const payload = weave.bootstrap({
        task: 'Fix the frontend dispatcher for /fulfillment/ship, /fulfillment/cancel, and /fulfillment/action endpoint behavior',
        maxFiles: 8,
        maxExemplars: 3,
      });

      expect(payload.scopeMismatch).toBeNull();
      expect(payload.entryCandidates[0]?.file).toBe('resources/js/composables/useFulfillmentApi.js');
      expect(payload.entryCandidates.map(candidate => candidate.file)).toContain('resources/js/composables/useFulfillmentApi.js');
      expect(payload.entryCandidates.map(candidate => candidate.file)).not.toContain('app/Actions/Admin/PreviewEmailAction.php');
      expect(payload.entryCandidates.map(candidate => candidate.file)).not.toContain('app/Actions/Admin/ShowAdminOrdersPageAction.php');
      expect(payload.entryCandidates.some(candidate => candidate.file.startsWith('tests/'))).toBe(false);

      const workingFiles = payload.context.workingSet.map(file => file.file);
      expect(workingFiles).toEqual(expect.arrayContaining([
        'resources/js/composables/useFulfillmentApi.js',
        'resources/js/Scripts/api.js',
        'routes/api.php',
      ]));
      expect(workingFiles).not.toContain('app/Actions/Admin/PreviewEmailAction.php');
      expect(workingFiles).not.toContain('app/Actions/Admin/ShowAdminOrdersPageAction.php');
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
          classification: 'internal_unresolved',
        }),
        expect.objectContaining({
          file: 'routes/web.php',
          layer: 3,
          plugin: 'laravel-actions',
          classification: 'internal_unresolved',
        }),
      ]));
      expect(status.diagnostics.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'resources/js/app.ts',
          details: expect.objectContaining({
            moduleSpecifier: 'vue',
          }),
        }),
      ]));

      const bootstrap = weave.bootstrap({
        task: 'Fix broken route wiring',
        start: 'resources/js/app.ts',
        maxFiles: 4,
      });
      expect(bootstrap.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'indexing_diagnostics_issues',
          details: expect.objectContaining({
            issueCount: expect.any(Number),
            l2EdgesSkipped: expect.any(Number),
            l3EdgesSkipped: expect.any(Number),
            internalIssues: expect.any(Number),
            externalIssues: expect.any(Number),
          }),
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
