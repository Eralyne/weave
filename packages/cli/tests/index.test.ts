import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';

const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

describe('CLI config loading', () => {
  it('uses an empty config when .weave/config.yaml is absent', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'weave-cli-config-'));
    projects.push(projectRoot);

    expect(loadConfig(projectRoot)).toEqual({});
  });

  it('parses project-local .weave/config.yaml', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'weave-cli-config-'));
    projects.push(projectRoot);
    mkdirSync(join(projectRoot, '.weave'), { recursive: true });
    writeFileSync(join(projectRoot, '.weave', 'config.yaml'), [
      'plugins:',
      '  - laravel-actions',
      'monorepo: true',
      '',
    ].join('\n'));

    expect(loadConfig(projectRoot)).toEqual({
      plugins: ['laravel-actions'],
      monorepo: true,
    });
  });
});
