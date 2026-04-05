# Weave

Convention-aware code intelligence graph for AI agents.

Weave turns a codebase into a queryable relationship graph so an agent can follow the existing implementation path instead of inventing one. It is built for maintenance-heavy work in established codebases, where the main problem is not generating code from scratch but finding the right files, patterns, and connected behavior quickly.

## What It Does

Weave indexes a repo into three layers:

- `L1`: symbols such as functions, methods, classes, components
- `L2`: language-level edges such as imports, calls, and inheritance
- `L3`: framework convention edges such as Laravel routes, Inertia renders, and Vue composable usage

The main agent-facing surface is `weave context`, which returns:

- `workingSet`: the small set of files most likely involved in the task
- `constraints`: short mined conventions from the codebase
- `exemplars`: nearby files that are structurally similar and worth imitating

This is designed to reduce wandering.

For invisible integrations, Weave also exposes `weave bootstrap`, which wraps the context bundle in a compact Weave-first operating contract for an agent or orchestrator.

## Current Scope

Current supported stack with real validation:

- Laravel
- Inertia
- Vue
- `lorisleiva/laravel-actions`

The graph engine is generic, but the current product-ready path is Laravel + Inertia + Vue.

## Quick Start

From the repo root:

```bash
npm install
npm run build
```

Build a graph for a target project:

```bash
node packages/cli/dist/bin.js init
```

Query minimal context:

```bash
node packages/cli/dist/bin.js context app/Actions/Auth/ShowLoginPageAction.php
```

Build an agent-ready bootstrap payload:

```bash
node packages/cli/dist/bin.js bootstrap app/Actions/Auth/ShowLoginPageAction.php --task "Add a login CTA copy tweak"
```

Graph artifacts are written to:

```text
.weave/graph.db
.weave/indexing-diagnostics.json
```

inside the target project root.

## CLI

Main commands:

- `weave init`
- `weave context <file>`
- `weave bootstrap <file> --task "..."`
- `weave query <file>`
- `weave status`
- `weave conventions`
- `weave validate <files...>`
- `weave impact <file-or-symbol>`

`weave context` is the preferred product surface for agents.
`weave bootstrap` is the preferred wrapper/orchestrator surface.

## MCP

The MCP server runs over stdio and takes the target project root as its first argument:

```bash
node /absolute/path/to/weave/packages/mcp/dist/index.js /absolute/path/to/project
```

Minimal MCP config:

```json
{
  "mcpServers": {
    "weave": {
      "command": "node",
      "args": [
        "/absolute/path/to/weave/packages/mcp/dist/index.js",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Exposed tools:

- `weave_context`
- `weave_bootstrap`
- `weave_query`
- `weave_status`
- `weave_conventions`
- `weave_validate`
- `weave_exemplar`
- `weave_impact`

For real use, Weave should usually be called automatically by the agent wrapper or orchestrator rather than left as an optional tool the model may ignore.

## Recommended Agent Workflow

Best practice is:

1. infer the likely task entry file
2. call `weave_bootstrap`
3. start the agent from the returned bootstrap payload
4. verify first-hop facts in code
5. widen search only if the bundle is insufficient

This is the intended product shape. Weave is most valuable when it is invisible and default, not when it sits beside grep as an optional tool.

If you are building an agent wrapper, the minimum contract is:

1. choose an entry file
2. call `weave_bootstrap`
3. inject `prompt` into the agent as the initial task framing
4. log whether the agent had to abandon the initial working set

## Confidence Model

Weave now distinguishes different confidence/provenance levels in the context bundle:

- `workingSet`: explicit graph evidence
- `constraints`: mined conventions, advisory
- `exemplars`: structural similarity, useful but weaker than direct graph edges

That distinction matters because Weave can be wrong. The product should help the agent start from the right path, not blindly trust every hint.
