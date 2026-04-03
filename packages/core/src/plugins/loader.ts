import { readFile, readdir, access, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { ConventionPlugin, PluginDetect, EdgeCreation } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Scans for .convention.yaml plugin files, validates their structure,
 * and auto-detects which plugins apply to the current project.
 */
export class PluginLoader {
  private projectRoot: string;
  private loadedPlugins: ConventionPlugin[] = [];

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Scan known locations for convention plugin YAML files,
   * validate each against the project's detect conditions,
   * and return only matching plugins.
   */
  async detectAndLoad(): Promise<ConventionPlugin[]> {
    const candidates = await this.scanForPluginFiles();
    const plugins: ConventionPlugin[] = [];

    for (const filePath of candidates) {
      const plugin = await this.parsePluginFile(filePath);
      if (!plugin) continue;

      const matches = await this.checkDetectConditions(plugin.detect);
      if (matches) {
        plugins.push(plugin);
      }
    }

    this.loadedPlugins = plugins;
    return plugins;
  }

  /** Return previously loaded plugins. */
  getLoadedPlugins(): ConventionPlugin[] {
    return this.loadedPlugins;
  }

  /**
   * Scan three locations for .convention.yaml files:
   * 1. Local project plugins: {projectRoot}/.weave/plugins/
   * 2. Installed npm plugins: {projectRoot}/node_modules/@weave/star/
   * 3. Built-in plugins: {repoRoot}/plugins/
   */
  private async scanForPluginFiles(): Promise<string[]> {
    const paths: string[] = [];

    const localDir = join(this.projectRoot, '.weave', 'plugins');
    const localFiles = await this.findYamlFiles(localDir);
    paths.push(...localFiles);

    const npmScopedDir = join(this.projectRoot, 'node_modules', '@weave');
    const npmFiles = await this.findYamlFilesInSubdirs(npmScopedDir);
    paths.push(...npmFiles);

    // Built-in plugins: relative to this package (packages/core/src/plugins/ -> ../../../../plugins/)
    const builtinDir = join(__dirname, '..', '..', '..', '..', 'plugins');
    const builtinFiles = await this.findYamlFiles(builtinDir);
    paths.push(...builtinFiles);

    return paths;
  }

  /** Find all .convention.yaml files in a single directory. */
  private async findYamlFiles(dir: string): Promise<string[]> {
    if (!(await this.directoryExists(dir))) return [];

    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.convention.yaml'))
      .map(e => join(dir, e.name));
  }

  /** Find .convention.yaml files inside immediate subdirectories (for node_modules/@weave/*/). */
  private async findYamlFilesInSubdirs(dir: string): Promise<string[]> {
    if (!(await this.directoryExists(dir))) return [];

    const paths: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = join(dir, entry.name);
      const files = await this.findYamlFiles(subDir);
      paths.push(...files);
    }

    return paths;
  }

  /** Parse a YAML file and validate it as a ConventionPlugin. Returns null on failure. */
  private async parsePluginFile(filePath: string): Promise<ConventionPlugin | null> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch {
      return null;
    }

    if (!this.isValidPluginShape(raw)) {
      return null;
    }

    return this.normalizePlugin(raw);
  }

  /**
   * Check all detect conditions against the project.
   * ALL conditions must match (files exist AND contains checks pass).
   */
  private async checkDetectConditions(detect: PluginDetect): Promise<boolean> {
    // Check required files exist
    for (const file of detect.files) {
      const fullPath = join(this.projectRoot, file);
      if (!(await this.fileExists(fullPath))) {
        return false;
      }
    }

    // Check file content contains required strings
    if (detect.contains) {
      for (const [file, searchString] of Object.entries(detect.contains)) {
        const fullPath = join(this.projectRoot, file);
        let content: string;
        try {
          content = await readFile(fullPath, 'utf-8');
        } catch {
          return false;
        }
        if (!content.includes(searchString)) {
          return false;
        }
      }
    }

    return true;
  }

  /** Validate that raw parsed YAML has the required ConventionPlugin shape. */
  private isValidPluginShape(raw: unknown): raw is Record<string, unknown> {
    if (typeof raw !== 'object' || raw === null) return false;

    const obj = raw as Record<string, unknown>;

    if (typeof obj['name'] !== 'string' || obj['name'].length === 0) return false;
    if (typeof obj['version'] !== 'string') return false;
    if (typeof obj['description'] !== 'string') return false;

    // Validate detect block
    const detect = obj['detect'];
    if (typeof detect !== 'object' || detect === null) return false;
    const detectObj = detect as Record<string, unknown>;
    if (!Array.isArray(detectObj['files'])) return false;
    if (detectObj['files'].some((f: unknown) => typeof f !== 'string')) return false;

    if (detectObj['contains'] !== undefined) {
      if (typeof detectObj['contains'] !== 'object' || detectObj['contains'] === null) return false;
      const contains = detectObj['contains'] as Record<string, unknown>;
      for (const [key, val] of Object.entries(contains)) {
        if (typeof key !== 'string' || typeof val !== 'string') return false;
      }
    }

    // Validate rules array
    if (!Array.isArray(obj['rules'])) return false;
    for (const rule of obj['rules']) {
      if (typeof rule !== 'object' || rule === null) return false;
      const r = rule as Record<string, unknown>;
      if (typeof r['name'] !== 'string') return false;
      if (typeof r['description'] !== 'string') return false;

      const match = r['match'];
      if (typeof match !== 'object' || match === null) return false;
      const m = match as Record<string, unknown>;
      if (typeof m['language'] !== 'string') return false;
      if (typeof m['pattern'] !== 'string') return false;

      if (!Array.isArray(r['creates'])) return false;
    }

    return true;
  }

  /** Normalize raw YAML data into a typed ConventionPlugin. */
  private normalizePlugin(raw: Record<string, unknown>): ConventionPlugin {
    const detect = raw['detect'] as Record<string, unknown>;
    const rules = (raw['rules'] as Array<Record<string, unknown>>).map(rule => {
      const match = rule['match'] as Record<string, unknown>;
      return {
        name: rule['name'] as string,
        description: rule['description'] as string,
        match: {
          language: match['language'] as string,
          filePattern: match['file_pattern'] as string | undefined,
          pattern: match['pattern'] as string,
        },
        creates: (rule['creates'] as unknown[]).map(c => {
          const entry = c as Record<string, unknown>;
          if (entry['edge'] !== undefined) {
            return { edge: this.normalizeEdgeCreation(entry['edge'] as Record<string, unknown>) };
          }
          if (entry['node'] !== undefined) {
            return { node: this.normalizeNodeCreation(entry['node'] as Record<string, unknown>) };
          }
          if (entry['node_metadata'] !== undefined) {
            return { node_metadata: this.normalizeNodeMetadata(entry['node_metadata'] as Record<string, unknown>) };
          }
          // Fallback — shouldn't reach here if validation passed, but handle gracefully
          return entry as { edge: never };
        }),
      };
    });

    return {
      name: raw['name'] as string,
      version: raw['version'] as string,
      description: raw['description'] as string,
      detect: {
        files: (detect['files'] as string[]),
        contains: detect['contains'] as Record<string, string> | undefined,
      },
      nodeKinds: raw['node_kinds'] as string[] | undefined,
      rules,
    };
  }

  private normalizeEdgeCreation(raw: Record<string, unknown>): EdgeCreation {
    return {
      from: this.normalizeFromTarget(raw['from']),
      to: this.normalizeToTarget(raw['to']),
      relationship: raw['relationship'] as string,
      metadata: raw['metadata'] as Record<string, string> | undefined,
    };
  }

  private normalizeFromTarget(
    raw: unknown,
  ): EdgeCreation['from'] {
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>;
      if (typeof obj['resolve'] === 'string') return { resolve: obj['resolve'] };
      if (typeof obj['resolve_class'] === 'string') return { resolve_class: obj['resolve_class'] };
      if (typeof obj['resolve_import'] === 'string') return { resolve_import: obj['resolve_import'] };
    }
    return raw as string;
  }

  private normalizeToTarget(
    raw: unknown,
  ): EdgeCreation['to'] {
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>;
      if (typeof obj['resolve'] === 'string') return { resolve: obj['resolve'] };
      if (typeof obj['resolve_class'] === 'string') return { resolve_class: obj['resolve_class'] };
      if (typeof obj['resolve_import'] === 'string') return { resolve_import: obj['resolve_import'] };
      if (typeof obj['resolve_migration'] === 'string') return { resolve_migration: obj['resolve_migration'] };
      if (typeof obj['all_of_kind'] === 'string') return { all_of_kind: obj['all_of_kind'] };
    }
    return raw as string;
  }

  private normalizeNodeCreation(raw: Record<string, unknown>): {
    file: string;
    kind: string;
    metadata?: Record<string, string>;
  } {
    return {
      file: raw['file'] as string,
      kind: raw['kind'] as string,
      metadata: raw['metadata'] as Record<string, string> | undefined,
    };
  }

  private normalizeNodeMetadata(raw: Record<string, unknown>): {
    kind: string;
    key: string;
    value: string;
  } {
    return {
      kind: raw['kind'] as string,
      key: raw['key'] as string,
      value: raw['value'] as string,
    };
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      const s = await stat(path);
      return s.isFile();
    } catch {
      return false;
    }
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      await access(path);
      const s = await stat(path);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
}
