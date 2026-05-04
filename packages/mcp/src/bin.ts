#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runServer } from './index.js';

interface ClaudeConfig {
  mcpServers?: Record<string, {
    type?: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

function usage(): void {
  console.log([
    'Usage:',
    '  weave-mcp                  Start the MCP server for the current repo',
    '  weave-mcp <project-root>   Start the MCP server for a specific repo',
    '  weave-mcp install-claude [project-root]',
    '',
    'install-claude writes a project .mcp.json that points Claude Code at',
    'the published @weave/mcp package via npx.',
  ].join('\n'));
}

function loadClaudeConfig(configPath: string): ClaudeConfig {
  if (!existsSync(configPath)) {
    return { mcpServers: {} };
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as ClaudeConfig;
  } catch {
    throw new Error(`Failed to parse existing Claude MCP config at ${configPath}`);
  }
}

function installClaude(projectRootArg?: string): void {
  const projectRoot = resolve(projectRootArg ?? process.cwd());
  mkdirSync(projectRoot, { recursive: true });

  const configPath = join(projectRoot, '.mcp.json');
  const config = loadClaudeConfig(configPath);
  config.mcpServers ??= {};
  config.mcpServers.weave = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@weave/mcp'],
    env: {},
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote ${configPath}`);
  console.log('Claude Code can now launch Weave in this repo with the current working directory as project root.');
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv.slice(2);

  if (command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'install-claude') {
    installClaude(rest[0]);
    return;
  }

  await runServer(command);
}

main(process.argv).catch((error) => {
  console.error('[weave-mcp] Fatal error:', error);
  process.exit(1);
});
