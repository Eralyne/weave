# Weave

Convention-aware, harness-agnostic code intelligence graph.

Weave builds a queryable graph of code relationships that understands framework conventions — not just language syntax. Any AI coding tool gets minimal, precise context for a task instead of raw file dumps.

## Problem

AI coding tools need codebase context to generate correct code. Current approaches fail in complementary ways:

**Embedding search** (Cursor, Copilot) finds semantically *similar* code. When fixing a bug in `ResolveCombatTurn`, you don't need code that *talks about* combat — you need code that *connects to* the turn resolution flow. Similarity is the wrong axis.

**Manual indexes** (CLAUDE.md, README files) require human maintenance. They go stale. They can't encode relationships. They dump global context when you need local precision.

**LSP/IDE intelligence** gives per-symbol navigation (go-to-definition, find-references). It can't answer "what's the minimal set of code I need to understand to safely change X" because it doesn't model cross-stack or convention-based relationships.

**No existing tool** models framework conventions as code relationships. No tool knows that `Inertia::render('Combat/BattleGrid', $props)` creates a dependency edge from a PHP action to a Vue component, carrying specific props. This convention knowledge is the missing layer.

## Solution

A three-layer graph that combines language-agnostic structural analysis with framework-specific convention awareness:

**Layer 1 — Symbols.** Tree-sitter parses any file into an AST. Extract universal primitives: function definitions, class declarations, imports, exports, variable bindings. These are graph nodes. One extractor, many grammars, ~100 languages supported.

**Layer 2 — Intra-language edges.** Import/require/use statements become dependency edges. Function calls become call edges. Class inheritance becomes hierarchy edges. These come from AST queries using Tree-sitter's pattern language. Language-specific query sets, but the mechanism is generic.

**Layer 3 — Convention edges.** Declarative YAML plugins define how frameworks create cross-language, cross-stack relationships. `Inertia::render()` maps PHP to Vue. `$this->hasMany()` links models. `Route::get()` connects URLs to handlers. Each plugin is 50-200 lines of YAML. The runtime interprets them. This is the novel contribution.

## Architecture

```
                    ┌─── MCP Server ──→ Claude Code, Cursor, Windsurf
                    │
                    ├─── CLI ─────────→ Codex, shell-based agents
                    │
SQLite Graph Store ─┼─── REST API ────→ Custom tools, CI pipelines
                    │
                    ├─── Git Hook ────→ Pre-commit convention validation
                    │
                    └─── LSP ─────────→ IDE diagnostics, hover info
```

Same graph, same conventions, same exemplar selection. Different consumers. The intelligence lives in the graph, not in any specific AI tool's prompt engineering.

### Storage

SQLite. Zero dependencies, embedded, portable, fast enough for single-repo graphs. Recursive CTEs handle graph traversal. No Docker, no external services. Installable via `npm install -g weave-graph` or `pip install weave-graph`.

The database file lives in the project root (`.weave/graph.db`) and is gitignored — it's a derived artifact, like `node_modules` or compiled assets.

## Data Model

### Nodes

```sql
CREATE TABLE nodes (
    id          INTEGER PRIMARY KEY,
    file_path   TEXT NOT NULL,          -- relative to project root
    symbol_name TEXT NOT NULL,          -- e.g. "ResolveCombatTurn", "useBattleGrid"
    kind        TEXT NOT NULL,          -- function, class, method, component, composable, model, migration, route, ...
    language    TEXT NOT NULL,          -- php, typescript, vue, python, ...
    line_start  INTEGER NOT NULL,
    line_end    INTEGER NOT NULL,
    signature   TEXT,                   -- function signature, class declaration, etc.
    metadata    TEXT                    -- JSON blob for kind-specific data (props, return types, etc.)
);

CREATE INDEX idx_nodes_file ON nodes(file_path);
CREATE INDEX idx_nodes_kind ON nodes(kind);
CREATE INDEX idx_nodes_symbol ON nodes(symbol_name);
```

### Edges

```sql
CREATE TABLE edges (
    id          INTEGER PRIMARY KEY,
    source_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL,         -- imports, calls, extends, implements, renders, has_many, belongs_to, validates_with, emits, listens, routes_to, ...
    layer       INTEGER NOT NULL,      -- 1 = structural, 2 = intra-language, 3 = convention
    convention  TEXT,                   -- which convention plugin created this edge (NULL for L1/L2)
    metadata    TEXT,                   -- JSON blob: carried props, HTTP method, relationship type, etc.
    confidence  REAL DEFAULT 1.0       -- 1.0 for static analysis, <1.0 for heuristic conventions
);

CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_edges_rel ON edges(relationship);
```

### Cache

```sql
CREATE TABLE file_cache (
    file_path   TEXT PRIMARY KEY,
    mtime       REAL NOT NULL,          -- file modification time
    hash        TEXT NOT NULL,          -- content hash for collision detection
    last_parsed TEXT NOT NULL           -- ISO 8601 timestamp
);
```

### Conventions (derived)

```sql
CREATE TABLE conventions (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,          -- the node kind this convention applies to
    property    TEXT NOT NULL,          -- what's conventional (e.g. "extends AsAction", "has FormRequest edge")
    frequency   INTEGER NOT NULL,      -- how many nodes of this kind have this property
    total       INTEGER NOT NULL,      -- total nodes of this kind
    confidence  REAL GENERATED ALWAYS AS (CAST(frequency AS REAL) / total) STORED,
    exemplar_id INTEGER REFERENCES nodes(id), -- best representative node
    metadata    TEXT                    -- JSON: the actual pattern details
);
```

## Convention Plugin Format

Convention plugins are declarative YAML files that define how frameworks create cross-language relationships.

### Plugin Structure

```yaml
# laravel-inertia.convention.yaml
name: laravel-inertia
version: 1.0.0
description: Laravel Inertia.js PHP-to-Vue page rendering

detect:
  # Auto-detected from project files. ALL conditions must match.
  files:
    - composer.json
  contains:
    composer.json: "inertiajs/inertia-laravel"

# Node kinds this plugin introduces or recognizes
node_kinds:
  - inertia_page        # A Vue component rendered by Inertia

rules:
  # Each rule: match a pattern in source, create edges in the graph
  - name: inertia-render
    description: Inertia::render connects a PHP handler to a Vue page component
    match:
      language: php
      # Tree-sitter query pattern (S-expression syntax)
      pattern: |
        (member_call_expression
          object: (name) @obj (#eq? @obj "Inertia")
          name: (name) @method (#eq? @method "render")
          arguments: (arguments
            (string (string_content) @component)
            (array_creation_expression)? @props))
    creates:
      - edge:
          from: current_symbol       # The function/method containing this call
          to:
            resolve: "resources/js/Pages/{@component}.vue"
          relationship: renders
          metadata:
            props: "@props"          # Capture the props array for downstream use
      - node:
          file: "resources/js/Pages/{@component}.vue"
          kind: inertia_page

  - name: inertia-shared-data
    description: Inertia::share makes data available to all page components
    match:
      language: php
      pattern: |
        (member_call_expression
          object: (name) @obj (#eq? @obj "Inertia")
          name: (name) @method (#eq? @method "share")
          arguments: (arguments
            (string (string_content) @key)
            . (_) @value))
    creates:
      - edge:
          from: current_symbol
          to:
            all_of_kind: inertia_page
          relationship: shares_data
          metadata:
            key: "@key"
```

### Composable Plugins

Plugins compose by referencing node kinds from other plugins:

```yaml
# vue-composition.convention.yaml
name: vue-composition
version: 1.0.0
description: Vue 3 Composition API composable relationships

detect:
  files:
    - package.json
  contains:
    package.json: '"vue"'

rules:
  - name: composable-usage
    description: Tracks which components use which composables
    match:
      language: typescript
      file_pattern: "**/*.vue"        # Only match inside Vue SFCs
      pattern: |
        (call_expression
          function: (identifier) @fn
          (#match? @fn "^use[A-Z]"))
    creates:
      - edge:
          from: current_symbol
          to:
            resolve_import: "@fn"     # Follow the import to find the composable definition
          relationship: uses_composable

  - name: define-props
    description: Tracks prop contracts between parent and child components
    match:
      language: typescript
      file_pattern: "**/*.vue"
      pattern: |
        (call_expression
          function: (identifier) @fn (#eq? @fn "defineProps")
          arguments: (arguments (object) @props_shape))
    creates:
      - node_metadata:
          kind: component
          key: props
          value: "@props_shape"
```

### Laravel Core Plugin

```yaml
# laravel-core.convention.yaml
name: laravel-core
version: 1.0.0
description: Laravel core framework conventions

detect:
  files:
    - artisan
    - composer.json
  contains:
    composer.json: "laravel/framework"

node_kinds:
  - action          # lorisleiva/laravel-actions handler
  - model           # Eloquent model
  - migration       # Database migration
  - form_request    # Validation request class
  - policy          # Authorization policy
  - event           # Event class
  - listener        # Event listener

rules:
  - name: action-route
    description: Actions registered as routes via AsController
    match:
      language: php
      file_pattern: "routes/*.php"
      pattern: |
        (member_call_expression
          name: (name) @method (#match? @method "^(get|post|put|patch|delete)$")
          arguments: (arguments
            (string (string_content) @path)
            (array_element_initializer
              (class_constant_access_expression
                (name) @class_name))))
    creates:
      - edge:
          from:
            resolve: "routes/{current_file}"
          to:
            resolve_class: "@class_name"
          relationship: routes_to
          metadata:
            method: "@method"
            path: "@path"

  - name: eloquent-has-many
    description: Eloquent hasMany relationship
    match:
      language: php
      pattern: |
        (member_call_expression
          object: (variable) @obj (#eq? @obj "$this")
          name: (name) @method (#eq? @method "hasMany")
          arguments: (arguments
            (class_constant_access_expression
              (name) @related_model
              (name) @const (#eq? @const "class"))))
    creates:
      - edge:
          from: current_symbol
          to:
            resolve_class: "@related_model"
          relationship: has_many

  - name: eloquent-belongs-to
    description: Eloquent belongsTo relationship
    match:
      language: php
      pattern: |
        (member_call_expression
          object: (variable) @obj (#eq? @obj "$this")
          name: (name) @method (#eq? @method "belongsTo")
          arguments: (arguments
            (class_constant_access_expression
              (name) @related_model
              (name) @const (#eq? @const "class"))))
    creates:
      - edge:
          from: current_symbol
          to:
            resolve_class: "@related_model"
          relationship: belongs_to

  - name: form-request-usage
    description: Type-hinted FormRequest in action/controller methods
    match:
      language: php
      pattern: |
        (formal_parameters
          (simple_parameter
            type: (named_type (name) @request_class)
            (#match? @request_class "Request$")))
    creates:
      - edge:
          from: current_symbol
          to:
            resolve_class: "@request_class"
          relationship: validates_with

  - name: model-to-migration
    description: Links models to their migration files by table name convention
    match:
      language: php
      file_pattern: "app/Models/*.php"
      pattern: |
        (property_declaration
          (property_element
            (variable_name) @var (#eq? @var "$table")
            (string (string_content) @table_name)))
    creates:
      - edge:
          from: current_symbol
          to:
            resolve_migration: "@table_name"    # Scans migration files for Schema::create(@table_name)
          relationship: migrated_by

  - name: event-dispatch
    description: Event dispatching
    match:
      language: php
      pattern: |
        (member_call_expression
          name: (name) @method (#eq? @method "dispatch")
          object: (class_constant_access_expression
            (name) @event_class))
    creates:
      - edge:
          from: current_symbol
          to:
            resolve_class: "@event_class"
          relationship: dispatches

  - name: policy-authorization
    description: Policy class authorization for models
    match:
      language: php
      file_pattern: "app/Policies/*.php"
      pattern: |
        (method_declaration
          name: (name) @method_name
          parameters: (formal_parameters
            (simple_parameter
              type: (named_type (name) @model_class)
              (#not-match? @model_class "^(User|Request)$"))))
    creates:
      - edge:
          from: current_symbol
          to:
            resolve_class: "@model_class"
          relationship: authorizes
```

## Resolution Strategies

Convention plugins reference targets using resolution strategies. The runtime provides these built-in resolvers:

| Strategy | Description | Example |
|---|---|---|
| `resolve` | Direct file path (with interpolation) | `resources/js/Pages/{@component}.vue` |
| `resolve_class` | Find class definition by short name | Searches `app/` for `class @name` |
| `resolve_import` | Follow import chain to definition | Traces `import { @fn } from './composables'` |
| `resolve_migration` | Find migration by table name | Scans `database/migrations/` for `Schema::create('@table')` |
| `all_of_kind` | All nodes of a specific kind | All `inertia_page` nodes |
| `current_symbol` | The enclosing function/class/method | Context-dependent |
| `current_file` | The file being analyzed | Context-dependent |

Custom resolvers can be registered by plugins for framework-specific lookup patterns.

## Subgraph Query API

The primary interface. Given a starting point and optional scope, return the minimal connected subgraph.

### Query Format

```json
{
  "start": "app/Actions/Combat/ResolveCombatTurn.php",
  "scope": "What connects to initiative resolution?",
  "depth": 3,
  "options": {
    "include_conventions": true,
    "include_exemplars": true,
    "include_snippets": true,
    "max_tokens": 4000
  }
}
```

### Response Format

```json
{
  "subgraph": {
    "nodes": [
      {
        "id": 142,
        "file": "app/Actions/Combat/ResolveCombatTurn.php",
        "symbol": "ResolveCombatTurn::handle",
        "kind": "action",
        "lines": [34, 78],
        "snippet": "public function handle(CombatTurnRequest $request, Encounter $encounter): Response { ... }"
      },
      {
        "id": 203,
        "file": "resources/js/Pages/Combat/BattleGrid.vue",
        "symbol": "BattleGrid",
        "kind": "inertia_page",
        "lines": [1, 245],
        "snippet": "<script setup lang=\"ts\"> ... const { encounter, participants } = defineProps<...>() ..."
      }
    ],
    "edges": [
      {
        "from": 142,
        "to": 203,
        "relationship": "renders",
        "convention": "laravel-inertia",
        "metadata": { "props": ["encounter", "participants"] }
      }
    ]
  },
  "conventions": [
    {
      "kind": "action",
      "rules": [
        "47/47 actions extend AsAction (confidence: 1.0)",
        "46/47 actions have a validates_with edge to a FormRequest (confidence: 0.98)",
        "44/47 actions have a renders edge to an Inertia page (confidence: 0.94)"
      ],
      "exemplar": {
        "file": "app/Actions/Combat/ResolveCombatTurn.php",
        "reason": "Same domain, highest edge similarity to query context"
      }
    }
  ]
}
```

### Traversal Algorithm

```
function subgraph(start_node, depth, scope):
    visited = {}
    queue = [(start_node, 0)]
    
    while queue is not empty:
        node, d = queue.pop()
        if d > depth or node in visited:
            continue
        visited[node] = d
        
        for edge in edges_from(node) + edges_to(node):
            neighbor = edge.other(node)
            priority = score(edge, scope)
            
            # Convention edges (L3) get priority — they cross boundaries
            # and are the most likely to be missed by the developer
            if edge.layer == 3:
                priority *= 2.0
            
            queue.push((neighbor, d + 1), priority)
    
    return prune_to_token_budget(visited, max_tokens)
```

Convention edges (Layer 3) are weighted higher during traversal because they cross language/framework boundaries — the connections most likely to be invisible to both humans and AI tools without the graph.

## Convention Inference Engine

Automatically derives coding conventions by mining patterns in the graph.

### Process

1. **Group nodes by kind** — all `action` nodes, all `component` nodes, all `composable` nodes.
2. **Extract shared properties** — for each group, find structural properties that most members share: common base classes, common edge patterns (e.g., "most actions have a `validates_with` edge"), common naming patterns, common file location patterns.
3. **Score confidence** — `frequency / total`. 47/47 = 1.0, 45/47 = 0.96.
4. **Detect anomalies** — nodes that deviate from high-confidence conventions. These are either legacy debt or intentional exceptions.
5. **Select exemplars** — for each convention, pick the node that best represents the pattern. Prefer nodes with the most convention-conforming edges, in the most common file location, with the most typical structure.

### Convention Types Detected

| Type | Example | Detection Method |
|---|---|---|
| Structural | "All route handlers are Action classes" | Group by kind, check base class |
| Edge pattern | "46/47 actions validate via FormRequest" | Count edges of type per kind |
| Naming | "Composables match `use{Name}` pattern" | Regex over symbol names per kind |
| Location | "Models live in `app/Models/`" | Group by kind, find path patterns |
| Relationship | "Every model has a migration" | Check edge existence per kind |

### Validation

After code generation, extract new nodes/edges and check against derived conventions:

```
function validate(new_file):
    new_nodes = extract_nodes(new_file)
    violations = []
    
    for node in new_nodes:
        conventions = get_conventions(node.kind)
        for conv in conventions:
            if conv.confidence >= 0.9 and not node.satisfies(conv):
                violations.append({
                    convention: conv,
                    node: node,
                    message: f"{node.symbol} is a {node.kind} but doesn't {conv.property}. "
                             f"{conv.frequency}/{conv.total} {node.kind}s do. "
                             f"See {conv.exemplar.file} for reference."
                })
    
    return violations
```

## Interface Surfaces

### MCP Server

Primary interface for AI coding tools. Exposes tools:

| Tool | Description |
|---|---|
| `weave_query` | Subgraph query — returns minimal connected context for a task |
| `weave_conventions` | Get derived conventions for a node kind |
| `weave_validate` | Check generated code against conventions |
| `weave_exemplar` | Get the best exemplar for a given kind and context |
| `weave_impact` | Blast radius — what would be affected by changing this symbol |
| `weave_status` | Index freshness, plugin status, graph stats |

### CLI

```bash
weave init                              # Detect frameworks, load plugins, build initial graph
weave query <file> [--scope "..."]      # Subgraph query
weave conventions [--kind action]       # Show derived conventions
weave validate <file>                   # Check file against conventions
weave impact <file:symbol>              # Blast radius analysis
weave status                            # Index stats
weave plugins                           # List active convention plugins
weave plugins add <name>                # Install a convention plugin
weave watch                             # File watcher for incremental updates
```

### Git Hook (pre-commit)

```bash
#!/bin/sh
# .git/hooks/pre-commit
staged=$(git diff --cached --name-only --diff-filter=ACM)
weave validate $staged --strict --exit-code
```

Validates all staged files against derived conventions. Fails the commit if a high-confidence convention is violated. Works regardless of which tool (human, Claude, Codex, Copilot) generated the code.

### REST API

```
GET  /api/query?file=...&scope=...&depth=3
GET  /api/conventions?kind=action
POST /api/validate  { files: [...] }
GET  /api/impact?symbol=...
GET  /api/status
```

Lightweight HTTP server for integration with CI pipelines, custom tooling, or non-MCP AI tools.

## Incremental Updates

The graph is never fully rebuilt after initial indexing. File changes trigger incremental updates:

1. **Detect changes** — file watcher or git diff provides changed file list.
2. **Check cache** — compare mtime/hash against `file_cache` table.
3. **Remove stale** — delete all nodes and edges from changed files.
4. **Re-extract** — parse changed files through Tree-sitter + convention plugins.
5. **Recompute affected conventions** — only conventions involving the changed node kinds.

Typical incremental update: <100ms for a single file change.

## Plugin Ecosystem

Convention plugins are distributed as packages:

```bash
weave plugins add @weave/laravel-core
weave plugins add @weave/laravel-inertia
weave plugins add @weave/vue-composition
weave plugins add @weave/tailwind
```

### Plugin Registry

Community-contributed plugins hosted in a central registry (npm-style or GitHub-based). Each plugin:

- Has a `detect` block for auto-activation
- Declares which `node_kinds` it introduces
- Defines `rules` using Tree-sitter query patterns
- Specifies version compatibility with Weave core
- Can depend on other plugins (e.g., `laravel-inertia` depends on `laravel-core`)

### Authoring a Plugin

A plugin is a single YAML file. The full authoring flow:

1. Identify a framework convention that creates cross-boundary relationships
2. Write a Tree-sitter query pattern that matches the source code pattern
3. Define what edges/nodes the match creates
4. Test with `weave plugins test my-plugin.convention.yaml`
5. Publish with `weave plugins publish`

## Project Structure

```
weave/
├── packages/
│   ├── core/                    # Graph engine, SQLite store, Tree-sitter integration
│   │   ├── src/
│   │   │   ├── graph/           # Node/edge CRUD, traversal, subgraph extraction
│   │   │   ├── parser/          # Tree-sitter wrapper, symbol extraction (L1/L2)
│   │   │   ├── conventions/     # Convention inference engine
│   │   │   ├── plugins/         # Plugin loader, YAML interpreter, resolver runtime
│   │   │   └── cache/           # File cache, mtime invalidation
│   │   └── tests/
│   ├── cli/                     # CLI interface
│   ├── mcp/                     # MCP server
│   ├── api/                     # REST API server
│   └── lsp/                     # Language server (future)
├── plugins/                     # First-party convention plugins
│   ├── laravel-core.convention.yaml
│   ├── laravel-inertia.convention.yaml
│   ├── vue-composition.convention.yaml
│   ├── nextjs.convention.yaml
│   ├── django.convention.yaml
│   └── rails-hotwire.convention.yaml
├── docs/
│   ├── plugin-authoring.md
│   └── query-api.md
└── SPEC.md                      # This file
```

## Implementation Language

TypeScript. Reasons:

- Tree-sitter has mature Node.js bindings (`tree-sitter` npm package)
- SQLite has `better-sqlite3` (synchronous, fast, zero-config)
- MCP SDK is TypeScript-first (`@modelcontextprotocol/sdk`)
- npm distribution for `weave` CLI
- Largest potential contributor base for plugins

## Design Decisions

1. **Scope resolution — LLM-assisted.** The consumer is an LLM, so the scope query (e.g., "what touches initiative resolution") is interpreted by the LLM itself. Weave provides the graph traversal primitives — the LLM decides which starting nodes to query and how to follow edges. The MCP tools expose low-level graph operations; the LLM composes them into meaningful exploration.

2. **Convention conflicts — flag for manual resolution, confidence-weighted fallback.** When two plugins produce contradictory conventions for the same node kind, Weave flags the conflict in `weave status` and `weave conventions` output. Until the user resolves it, the higher-confidence convention is used as the fallback. Resolution is stored in `.weave/config.yaml` under a `convention_overrides` key.

3. **Monorepo support — optional, separate graphs per package.** Default: single graph for the project root. With `monorepo: true` in `.weave/config.yaml`, Weave maintains a separate graph per package (detected via `workspaces` in `package.json`, `packages/*/composer.json`, etc.). Cross-package edges are tracked via a lightweight reference table linking package graphs.

4. **Dynamic/runtime conventions — out of scope.** Weave is a static analysis tool. Runtime-only relationships (service container bindings, dynamically registered event subscribers, middleware stacks) are not Loom's problem. If a relationship isn't visible in source code, it doesn't exist in the graph. Frameworks that want better Weave support should make their conventions statically analyzable (most already do through configuration files, attributes, or type hints).

5. **Token budget pruning — distance from start.** When the subgraph exceeds `max_tokens`, nodes furthest from the query starting point are pruned first. Convention edges (L3) still get priority weighting during traversal, so cross-boundary nodes are reached sooner and survive pruning. This is simple, predictable, and avoids the overhead of LLM-assisted relevance scoring during graph extraction.

6. **Convention overrides — config file.** Intentional exceptions are declared in `.weave/config.yaml`:

```yaml
convention_overrides:
  - file: "app/Actions/Legacy/OldImportAction.php"
    skip_conventions:
      - "validates_with_form_request"
    reason: "Legacy action predates FormRequest pattern, scheduled for rewrite in Q3"

  - kind: "action"
    symbol: "HealthCheckAction"
    skip_conventions:
      - "renders_inertia_page"
    reason: "Returns JSON, not a page — intentionally no Inertia render"
```

The inference engine excludes overridden nodes from convention frequency calculations. The validator skips overridden checks but still reports them as informational (not blocking). Overrides without a `reason` field are rejected — forcing documentation of why the exception exists.
