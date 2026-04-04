import { GraphStore } from './graph/store.js';
import { SubgraphExtractor } from './graph/subgraph.js';
import { TreeSitterParser } from './parser/parser.js';
import { SymbolExtractor } from './parser/symbols.js';
import { PluginLoader } from './plugins/loader.js';
import { PluginRunner } from './plugins/runner.js';
import { ConventionEngine } from './conventions/engine.js';
import { ConventionValidator } from './conventions/validator.js';
import { FileWatcher } from './cache/watcher.js';
import { toProjectRelative } from './path-utils.js';
import type {
  WeaveConfig,
  WeaveNode,
  WeaveEdge,
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
    this.store.initialize();
    this.parser = new TreeSitterParser();
    this.symbolExtractor = new SymbolExtractor(this.parser);
    this.pluginLoader = new PluginLoader(projectRoot);
    this.pluginRunner = new PluginRunner(this.store, this.parser, projectRoot);
    this.subgraph = new SubgraphExtractor(this.store, projectRoot);
    this.conventionEngine = new ConventionEngine(this.store, this.config);
    this.validator = new ConventionValidator(this.conventionEngine, this.config, projectRoot);
    this.watcher = new FileWatcher(this.store);
  }

  /** Detect frameworks, load plugins, build initial graph. */
  async init(): Promise<{ plugins: string[]; nodeCount: number; edgeCount: number }> {
    this.store.resetGraph();
    const plugins = await this.pluginLoader.detectAndLoad();

    const files = await this.watcher.discoverFiles(this.projectRoot);

    // Pass 1: extract all nodes (L1 symbols)
    for (const file of files) {
      const { nodes: partials } = this.symbolExtractor.extractFull(file);
      for (const partial of partials) {
        this.store.upsertNode({
          id: 0,
          filePath: this.toRelativePath(partial.filePath ?? file),
          symbolName: partial.symbolName ?? 'unknown',
          kind: partial.kind ?? 'unknown',
          language: partial.language ?? this.parser.getLanguage(file),
          lineStart: partial.lineStart ?? 0,
          lineEnd: partial.lineEnd ?? 0,
          signature: partial.signature ?? null,
          metadata: partial.metadata ?? null,
        });
      }
    }

    // Pass 2: resolve edges (L2 + L3) now that all nodes exist
    for (const file of files) {
      await this.indexFileEdges(file, plugins);
      this.watcher.updateCache(file);
    }

    this.conventionEngine.recompute();

    const stats = this.store.getStats();
    return { plugins: plugins.map(p => p.name), ...stats };
  }

  /** Index a single file: extract L1/L2 symbols+edges, then run L3 convention plugins. */
  async indexFile(filePath: string, plugins: ConventionPlugin[]): Promise<void> {
    // L1 + L2: language-level symbols and edges
    const { nodes: partials, edges: extractedEdges } = this.symbolExtractor.extractFull(filePath);

    // Upsert nodes and build a lookup map for edge resolution
    const upsertedBySymbol = new Map<string, WeaveNode>();
    for (const partial of partials) {
      const node: WeaveNode = {
        id: 0,
        filePath: this.toRelativePath(partial.filePath ?? filePath),
        symbolName: partial.symbolName ?? 'unknown',
        kind: partial.kind ?? 'unknown',
        language: partial.language ?? this.parser.getLanguage(filePath),
        lineStart: partial.lineStart ?? 0,
        lineEnd: partial.lineEnd ?? 0,
        signature: partial.signature ?? null,
        metadata: partial.metadata ?? null,
      };
      const upserted = this.store.upsertNode(node);
      upsertedBySymbol.set(upserted.symbolName, upserted);
    }

    // Resolve and persist L2 edges
    this.persistExtractedEdges(filePath, extractedEdges, upsertedBySymbol);

    // L3: convention plugin edges
    for (const plugin of plugins) {
      this.pluginRunner.applyRules(filePath, plugin);
    }

    this.watcher.updateCache(filePath);
  }

  /** Index only edges for a file (L2 extracted + L3 convention plugins). Used in pass 2 of init. */
  private async indexFileEdges(filePath: string, plugins: ConventionPlugin[]): Promise<void> {
    const { edges: extractedEdges } = this.symbolExtractor.extractFull(filePath);
    const relFile = this.toRelativePath(filePath);

    // Build local node lookup from already-stored nodes for this file
    const fileNodes = this.store.getNodesByFile(relFile);
    const localNodes = new Map<string, WeaveNode>();
    for (const n of fileNodes) {
      localNodes.set(n.symbolName, n);
    }

    // L2 edges
    this.persistExtractedEdges(filePath, extractedEdges, localNodes);

    // L3: convention plugin edges
    for (const plugin of plugins) {
      this.pluginRunner.applyRules(filePath, plugin);
    }
  }

  /**
   * Resolve placeholder source/target IDs for an extracted L2 edge.
   * Returns real node IDs or null if either side cannot be resolved.
   */
  private persistExtractedEdges(
    filePath: string,
    extractedEdges: Partial<WeaveEdge>[],
    localNodes: Map<string, WeaveNode>,
  ): void {
    for (const edge of extractedEdges) {
      const resolvedPairs = this.resolveEdgePairs(
        edge,
        filePath,
        localNodes,
      );

      for (const resolved of resolvedPairs) {
        this.store.createEdge({
          sourceId: resolved.sourceId,
          targetId: resolved.targetId,
          relationship: edge.relationship ?? 'unknown',
          layer: 2,
          convention: edge.convention ?? null,
          metadata: edge.metadata ?? null,
          confidence: edge.confidence ?? 1.0,
        });
      }
    }
  }

  private resolveEdgePairs(
    edge: Partial<WeaveEdge>,
    filePath: string,
    localNodes: Map<string, WeaveNode>,
  ): Array<{ sourceId: number; targetId: number }> {
    const meta = (edge.metadata ?? {}) as Record<string, unknown>;
    const sourceSymbol = meta.sourceSymbol as string | undefined;
    const targetSymbol = meta.targetSymbol as string | undefined;
    const importedSymbol = meta.importedSymbol as string | undefined;
    const importedNames = Array.isArray(meta.importedNames)
      ? meta.importedNames.filter((value): value is string => typeof value === 'string')
      : [];
    const sourceFile = meta.sourceFile as string | undefined;

    const sourceIds: number[] = [];
    if (sourceSymbol) {
      const resolved = this.resolveSymbolId(sourceSymbol, localNodes);
      if (resolved !== undefined) {
        sourceIds.push(resolved);
      }
    } else if (sourceFile ?? filePath) {
      sourceIds.push(this.ensureFileNodeId(sourceFile ?? filePath));
    }

    const targetIds = new Set<number>();
    if (targetSymbol) {
      const resolved = this.resolveSymbolId(targetSymbol, localNodes);
      if (resolved !== undefined) {
        targetIds.add(resolved);
      }
    } else if (importedSymbol) {
      const resolved = this.resolveSymbolId(importedSymbol, localNodes);
      if (resolved !== undefined) {
        targetIds.add(resolved);
      }
    } else {
      for (const importedName of importedNames) {
        const resolved = this.resolveSymbolId(importedName, localNodes);
        if (resolved !== undefined) {
          targetIds.add(resolved);
        }
      }
    }

    if (sourceIds.length === 0 || targetIds.size === 0) return [];

    const pairs: Array<{ sourceId: number; targetId: number }> = [];
    for (const sourceId of sourceIds) {
      for (const targetId of targetIds) {
        pairs.push({ sourceId, targetId });
      }
    }
    return pairs;
  }

  /**
   * Look up a symbol's node ID: first in locally upserted nodes, then in the store.
   */
  private resolveSymbolId(
    symbolName: string,
    localNodes: Map<string, WeaveNode>,
  ): number | undefined {
    const local = localNodes.get(symbolName);
    if (local) return local.id;

    const storeNodes = this.store.findNodeBySymbol(symbolName);
    if (storeNodes.length > 0) return storeNodes[0].id;

    const shortName = this.getShortSymbolName(symbolName);
    if (shortName !== symbolName) {
      const localShort = localNodes.get(shortName);
      if (localShort) return localShort.id;

      const shortNodes = this.store.findNodeBySymbol(shortName);
      if (shortNodes.length > 0) return shortNodes[0].id;
    }

    return undefined;
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

  /** Get the best exemplar for a node kind. */
  exemplar(kind: string, contextNodeId?: number): {
    nodeId: number;
    file: string;
    reason: string;
  } | null {
    return this.conventionEngine.getExemplar(kind, contextNodeId);
  }

  /** Blast radius: what would be affected by changing a symbol. */
  impact(fileOrSymbol: string): SubgraphResult {
    return this.subgraph.impact(fileOrSymbol);
  }

  /** Graph stats: node/edge counts, plugin status, freshness. */
  async status(): Promise<{ nodeCount: number; edgeCount: number; plugins: string[]; staleFiles: string[] }> {
    const stats = this.store.getStats();
    const loadedPlugins = this.pluginLoader.getLoadedPlugins();
    const plugins = (
      loadedPlugins.length > 0
        ? loadedPlugins
        : await this.pluginLoader.detectAndLoad()
    ).map(p => p.name);
    const staleFiles = this.watcher.getStaleFiles();
    return { ...stats, plugins, staleFiles };
  }

  /** Incremental update: re-index changed files. */
  async update(changedFiles?: string[]): Promise<void> {
    const files = changedFiles ?? this.watcher.getStaleFiles();
    const loadedPlugins = this.pluginLoader.getLoadedPlugins();
    const plugins = loadedPlugins.length > 0
      ? loadedPlugins
      : await this.pluginLoader.detectAndLoad();

    for (const file of files) {
      const relativeFile = this.toRelativePath(file);
      this.store.removeFileNodes(relativeFile);

      if (await this.fileExists(file)) {
        await this.indexFile(file, plugins);
      } else {
        this.store.deleteFileCache(file);
        this.parser.invalidate(file);
      }
    }

    this.conventionEngine.recompute();
  }

  /** Clean shutdown. */
  close(): void {
    this.store.close();
  }

  private ensureFileNodeId(filePath: string): number {
    const relativePath = this.toRelativePath(filePath);
    const existingFileNode = this.store.getNodesByFile(relativePath)
      .find(node => node.kind === 'file');
    if (existingFileNode) {
      return existingFileNode.id;
    }

    const created = this.store.upsertNode({
      id: 0,
      filePath: relativePath,
      symbolName: relativePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? relativePath,
      kind: 'file',
      language: this.parser.getLanguage(filePath),
      lineStart: 1,
      lineEnd: 1,
      signature: null,
      metadata: null,
    });
    return created.id;
  }

  private getShortSymbolName(symbolName: string): string {
    return symbolName
      .split(/[\\/]/)
      .pop()
      ?.split('.')
      .shift()
      ?.split('\\')
      .pop()
      ?? symbolName;
  }

  private toRelativePath(filePath: string): string {
    return toProjectRelative(this.projectRoot, filePath);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const fs = await import('node:fs/promises');
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
