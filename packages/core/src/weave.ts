import { GraphStore } from './graph/store.js';
import { SubgraphExtractor } from './graph/subgraph.js';
import { TreeSitterParser } from './parser/parser.js';
import { SymbolExtractor } from './parser/symbols.js';
import { PluginLoader } from './plugins/loader.js';
import { PluginRunner } from './plugins/runner.js';
import { ConventionEngine } from './conventions/engine.js';
import { ConventionValidator } from './conventions/validator.js';
import { FileWatcher } from './cache/watcher.js';
import type {
  WeaveConfig,
  SubgraphQuery,
  SubgraphResult,
  ValidationViolation,
  Convention,
  ConventionPlugin,
} from './types.js';

/**
 * Main orchestrator. Wires together the graph store, parser, plugin system,
 * convention engine, and cache. All interface surfaces (CLI, MCP, REST) go
 * through this class.
 */
export class Weave {
  private store: GraphStore;
  private parser: TreeSitterParser;
  private symbolExtractor: SymbolExtractor;
  private pluginLoader: PluginLoader;
  private pluginRunner: PluginRunner;
  private subgraph: SubgraphExtractor;
  private conventionEngine: ConventionEngine;
  private validator: ConventionValidator;
  private watcher: FileWatcher;
  private config: WeaveConfig;

  constructor(private projectRoot: string, config?: Partial<WeaveConfig>) {
    this.config = { monorepo: false, conventionOverrides: [], plugins: [], ...config };
    this.store = new GraphStore(projectRoot);
    this.parser = new TreeSitterParser();
    this.symbolExtractor = new SymbolExtractor(this.parser);
    this.pluginLoader = new PluginLoader(projectRoot);
    this.pluginRunner = new PluginRunner(this.store, this.parser);
    this.subgraph = new SubgraphExtractor(this.store);
    this.conventionEngine = new ConventionEngine(this.store, this.config);
    this.validator = new ConventionValidator(this.conventionEngine, this.config);
    this.watcher = new FileWatcher(this.store);
  }

  /** Detect frameworks, load plugins, build initial graph. */
  async init(): Promise<{ plugins: string[]; nodeCount: number; edgeCount: number }> {
    this.store.initialize();
    const plugins = await this.pluginLoader.detectAndLoad();

    const files = await this.watcher.discoverFiles(this.projectRoot);
    for (const file of files) {
      await this.indexFile(file, plugins);
    }

    this.conventionEngine.recompute();

    const stats = this.store.getStats();
    return { plugins: plugins.map(p => p.name), ...stats };
  }

  /** Index a single file: extract L1/L2 symbols+edges, then run L3 convention plugins. */
  async indexFile(filePath: string, plugins: ConventionPlugin[]): Promise<void> {
    // L1 + L2: language-level symbols and edges
    const nodes = this.symbolExtractor.extract(filePath);
    for (const node of nodes) {
      this.store.upsertNode(node);
    }

    // L3: convention plugin edges
    for (const plugin of plugins) {
      this.pluginRunner.applyRules(filePath, plugin);
    }

    this.watcher.updateCache(filePath);
  }

  /** Subgraph query: minimal connected context for a task. */
  query(query: SubgraphQuery): SubgraphResult {
    return this.subgraph.extract(query);
  }

  /** Get derived conventions for a node kind. */
  conventions(kind?: string): Convention[] {
    return this.conventionEngine.getConventions(kind);
  }

  /** Validate files against derived conventions. */
  validate(filePaths: string[]): ValidationViolation[] {
    return this.validator.validate(filePaths);
  }

  /** Blast radius: what would be affected by changing a symbol. */
  impact(fileOrSymbol: string): SubgraphResult {
    return this.subgraph.impact(fileOrSymbol);
  }

  /** Graph stats: node/edge counts, plugin status, freshness. */
  status(): { nodeCount: number; edgeCount: number; plugins: string[]; staleFiles: string[] } {
    const stats = this.store.getStats();
    const plugins = this.pluginLoader.getLoadedPlugins().map(p => p.name);
    const staleFiles = this.watcher.getStaleFiles();
    return { ...stats, plugins, staleFiles };
  }

  /** Incremental update: re-index changed files. */
  async update(changedFiles?: string[]): Promise<void> {
    const files = changedFiles ?? this.watcher.getStaleFiles();
    const plugins = this.pluginLoader.getLoadedPlugins();

    for (const file of files) {
      this.store.removeFileNodes(file);
      await this.indexFile(file, plugins);
    }

    this.conventionEngine.recompute();
  }

  /** Clean shutdown. */
  close(): void {
    this.store.close();
  }
}
