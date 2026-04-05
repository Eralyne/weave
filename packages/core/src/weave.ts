import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GraphStore } from './graph/store.js';
import { IndexingDiagnosticsCollector } from './indexing-diagnostics.js';
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
  ContextBundleQuery,
  ContextBundle,
  ContextFile,
  ContextConstraint,
  ContextExemplar,
  SubgraphNode,
  ValidationViolation,
  Convention,
  ConventionPlugin,
  WeaveStatus,
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
  private diagnostics: IndexingDiagnosticsCollector;
  private diagnosticsPath: string;

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
    this.diagnostics = new IndexingDiagnosticsCollector();
    this.diagnosticsPath = join(projectRoot, '.weave', 'indexing-diagnostics.json');
  }

  /** Detect frameworks, load plugins, build initial graph. */
  async init(): Promise<{ plugins: string[]; nodeCount: number; edgeCount: number }> {
    this.store.resetGraph();
    this.diagnostics.reset();
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
    this.persistDiagnostics();

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
      this.pluginRunner.applyRules(filePath, plugin, this.diagnostics);
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
      this.pluginRunner.applyRules(filePath, plugin, this.diagnostics);
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
    const relativeFilePath = this.toRelativePath(filePath);
    for (const edge of extractedEdges) {
      const { pairs: resolvedPairs, reason, details } = this.resolveEdgePairs(
        edge,
        filePath,
        localNodes,
      );

      if (resolvedPairs.length === 0) {
        this.diagnostics.recordL2EdgeSkipped(
          relativeFilePath,
          edge.relationship,
          reason ?? 'unresolved_edge',
          details,
        );
        continue;
      }

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
      this.diagnostics.recordL2EdgeCreated(relativeFilePath, resolvedPairs.length);
    }
  }

  private resolveEdgePairs(
    edge: Partial<WeaveEdge>,
    filePath: string,
    localNodes: Map<string, WeaveNode>,
  ): {
    pairs: Array<{ sourceId: number; targetId: number }>;
    reason?: string;
    details?: Record<string, unknown>;
  } {
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

    if (sourceIds.length === 0 || targetIds.size === 0) {
      return {
        pairs: [],
        reason: this.unresolvedL2Reason(sourceIds.length === 0, targetIds.size === 0),
        details: {
          sourceSymbol: sourceSymbol ?? null,
          targetSymbol: targetSymbol ?? null,
          importedSymbol: importedSymbol ?? null,
          importedNames,
          sourceFile: sourceFile ?? null,
        },
      };
    }

    const pairs: Array<{ sourceId: number; targetId: number }> = [];
    for (const sourceId of sourceIds) {
      for (const targetId of targetIds) {
        pairs.push({ sourceId, targetId });
      }
    }
    return { pairs };
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

  /**
   * Context bundle: compact task context for an agent.
   * Returns a minimal working set, short mined constraints, and exemplar files.
   */
  context(query: ContextBundleQuery): ContextBundle {
    const result = this.subgraph.extract({
      start: query.start,
      scope: query.scope,
      depth: query.depth,
      options: {
        includeConventions: false,
        includeExemplars: false,
        includeSnippets: false,
      },
    });

    return {
      workingSet: this.buildWorkingSet(result, query),
      constraints: this.buildContextConstraints(result, query),
      exemplars: this.buildContextExemplars(result, query),
    };
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
  async status(): Promise<WeaveStatus> {
    const stats = this.store.getStats();
    const loadedPlugins = this.pluginLoader.getLoadedPlugins();
    const plugins = (
      loadedPlugins.length > 0
        ? loadedPlugins
        : await this.pluginLoader.detectAndLoad()
    ).map(p => p.name);
    const staleFiles = this.watcher.getStaleFiles();
    const diagnostics = this.getDiagnosticsSnapshot();
    return {
      ...stats,
      plugins,
      staleFiles,
      diagnostics,
    };
  }

  /** Incremental update: re-index changed files. */
  async update(changedFiles?: string[]): Promise<void> {
    const files = changedFiles ?? this.watcher.getStaleFiles();
    const loadedPlugins = this.pluginLoader.getLoadedPlugins();
    const plugins = loadedPlugins.length > 0
      ? loadedPlugins
      : await this.pluginLoader.detectAndLoad();

    // Convention exemplars reference node IDs, so clear derived data before
    // removing/replacing nodes during incremental updates.
    this.store.clearConventions();

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
    this.persistDiagnostics();
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

  private unresolvedL2Reason(sourceMissing: boolean, targetMissing: boolean): string {
    if (sourceMissing && targetMissing) return 'missing_source_and_target';
    if (sourceMissing) return 'missing_source';
    if (targetMissing) return 'missing_target';
    return 'unresolved_edge';
  }

  private getDiagnosticsSnapshot() {
    const current = this.diagnostics.snapshot();
    const hasCurrentData =
      current.files.length > 0
      || current.pluginRules.length > 0
      || current.issues.length > 0;

    if (hasCurrentData) {
      return current;
    }

    if (!existsSync(this.diagnosticsPath)) {
      return current;
    }

    try {
      return JSON.parse(readFileSync(this.diagnosticsPath, 'utf-8'));
    } catch {
      return current;
    }
  }

  private persistDiagnostics(): void {
    writeFileSync(this.diagnosticsPath, JSON.stringify(this.diagnostics.snapshot(), null, 2));
  }

  private buildWorkingSet(result: SubgraphResult, query: ContextBundleQuery): ContextFile[] {
    const start = this.toRelativePath(query.start);
    const maxFiles = query.maxFiles ?? 8;
    const filteredNodes = result.nodes.filter(node => !this.isGeneratedPath(node.file));
    const filteredNodeIds = new Set(filteredNodes.map(node => node.id));
    const filteredEdges = result.edges.filter(
      edge => filteredNodeIds.has(edge.from) && filteredNodeIds.has(edge.to),
    );
    const nodeById = new Map(filteredNodes.map(node => [node.id, node] as const));
    const fileEntries = new Map<string, {
      file: string;
      kinds: Set<string>;
      reasons: Set<string>;
      anchors: SubgraphNode[];
      score: number;
    }>();

    for (const node of filteredNodes) {
      const entry = this.getOrCreateFileEntry(fileEntries, node.file);
      entry.kinds.add(node.kind);
      if (node.kind !== 'file') {
        entry.score += 5;
        entry.anchors.push(node);
      }
      if (node.file === start) {
        entry.reasons.add('start target');
        entry.score += 100;
      }
    }

    for (const edge of filteredEdges) {
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (!fromNode || !toNode || fromNode.file === toNode.file) {
        continue;
      }

      const label = edge.convention
        ? `${edge.relationship} (${edge.convention})`
        : edge.relationship;

      const fromEntry = this.getOrCreateFileEntry(fileEntries, fromNode.file);
      const toEntry = this.getOrCreateFileEntry(fileEntries, toNode.file);

      fromEntry.reasons.add(`connected by ${label}`);
      toEntry.reasons.add(`connected by ${label}`);

      const edgeScore = fromNode.file === start || toNode.file === start ? 20 : 10;
      fromEntry.score += edgeScore;
      toEntry.score += edgeScore;
    }

    return Array.from(fileEntries.values())
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, maxFiles)
      .map(entry => ({
        file: entry.file,
        kinds: Array.from(entry.kinds).sort(),
        reasons: this.sortReasons(entry.reasons),
        anchors: entry.anchors
          .sort((a, b) => this.anchorPriority(b) - this.anchorPriority(a) || a.lines[0] - b.lines[0])
          .slice(0, 3)
          .map(node => ({
            symbol: node.symbol,
            kind: node.kind,
            lines: node.lines,
          })),
      }));
  }

  private buildContextConstraints(
    result: SubgraphResult,
    query: ContextBundleQuery,
  ): ContextConstraint[] {
    const maxConstraints = query.maxConstraints ?? 6;
    const workingKinds = this.getPreferredContextKinds(result);

    const constraints: ContextConstraint[] = [];
    for (const kind of workingKinds) {
      const conventions = this.conventionEngine.getConventions(kind)
        .filter(convention => convention.confidence >= 0.6)
        .sort((a, b) => b.confidence - a.confidence || b.frequency - a.frequency)
        .slice(0, 1);

      for (const convention of conventions) {
        const exemplarFile = convention.exemplarId !== null
          ? this.store.getNodeById(convention.exemplarId)?.filePath ?? null
          : null;
        if (exemplarFile && this.isGeneratedPath(exemplarFile)) {
          continue;
        }

        constraints.push({
          kind,
          rule: convention.property,
          confidence: convention.confidence,
          frequency: convention.frequency,
          total: convention.total,
          exemplarFile,
        });
      }
    }

    return constraints
      .sort((a, b) => b.confidence - a.confidence || b.frequency - a.frequency)
      .slice(0, maxConstraints);
  }

  private buildContextExemplars(
    result: SubgraphResult,
    query: ContextBundleQuery,
  ): ContextExemplar[] {
    const maxExemplars = query.maxExemplars ?? 3;
    const workingFiles = new Set(
      result.nodes
        .filter(node => !this.isGeneratedPath(node.file))
        .map(node => node.file),
    );
    const preferredKinds = new Set(this.getPreferredContextKinds(result));
    const nodeByKind = new Map<string, SubgraphNode>();

    for (const node of result.nodes) {
      if (node.kind === 'file' || this.isGeneratedPath(node.file)) {
        continue;
      }
      if (!preferredKinds.has(node.kind)) {
        continue;
      }
      if (node.kind === 'method' && !node.symbol.endsWith('::asController')) {
        continue;
      }
      if (nodeByKind.has(node.kind)) {
        continue;
      }
      nodeByKind.set(node.kind, node);
    }

    const exemplars: ContextExemplar[] = [];
    for (const [kind, node] of nodeByKind) {
      const exemplar = this.conventionEngine.getExemplar(kind, node.id);
      if (!exemplar || workingFiles.has(exemplar.file) || this.isGeneratedPath(exemplar.file)) {
        continue;
      }

      exemplars.push({
        kind,
        file: exemplar.file,
        reason: exemplar.reason,
        nodeId: exemplar.nodeId,
      });
    }

    const deduped = new Map<string, ContextExemplar>();
    for (const exemplar of exemplars) {
      const key = `${exemplar.kind}:${exemplar.file}`;
      if (!deduped.has(key)) {
        deduped.set(key, exemplar);
      }
    }

    return Array.from(deduped.values()).slice(0, maxExemplars);
  }

  private getOrCreateFileEntry(
    entries: Map<string, {
      file: string;
      kinds: Set<string>;
      reasons: Set<string>;
      anchors: SubgraphNode[];
      score: number;
    }>,
    file: string,
  ) {
    const existing = entries.get(file);
    if (existing) {
      return existing;
    }

    const created = {
      file,
      kinds: new Set<string>(),
      reasons: new Set<string>(),
      anchors: [] as SubgraphNode[],
      score: 0,
    };
    entries.set(file, created);
    return created;
  }

  private sortReasons(reasons: Set<string>): string[] {
    return Array.from(reasons)
      .sort((a, b) => {
        if (a === 'start target') return -1;
        if (b === 'start target') return 1;
        return a.localeCompare(b);
      })
      .slice(0, 3);
  }

  private getPreferredContextKinds(result: SubgraphResult): string[] {
    const availableKinds = new Set(
      result.nodes
        .filter(node => !this.isGeneratedPath(node.file))
        .map(node => node.kind)
        .filter(kind => kind !== 'file'),
    );

    const preferredKinds: string[] = [];
    for (const kind of ['action', 'inertia_page', 'component']) {
      if (availableKinds.has(kind)) {
        preferredKinds.push(kind);
      }
    }

    const hasControllerMethod = result.nodes.some(
      node => !this.isGeneratedPath(node.file)
        && node.kind === 'method'
        && node.symbol.endsWith('::asController'),
    );
    if (hasControllerMethod) {
      preferredKinds.push('method');
    }

    if (preferredKinds.length > 0) {
      return preferredKinds;
    }

    return Array.from(availableKinds)
      .sort((a, b) => this.bundleKindPriority(b) - this.bundleKindPriority(a) || a.localeCompare(b))
      .slice(0, 4);
  }

  private anchorPriority(node: SubgraphNode): number {
    if (node.symbol.endsWith('::asController')) return 100;
    if (node.kind === 'inertia_page') return 95;
    if (node.kind === 'component') return 90;
    if (node.kind === 'action') return 85;
    if (node.kind === 'method') return 80;
    if (node.kind === 'class') return 70;
    if (node.kind === 'function') return 60;
    return 50;
  }

  private bundleKindPriority(kind: string): number {
    switch (kind) {
      case 'action':
        return 100;
      case 'inertia_page':
        return 95;
      case 'component':
        return 90;
      case 'method':
        return 80;
      case 'class':
        return 60;
      case 'function':
        return 55;
      default:
        return 50;
    }
  }

  private isGeneratedPath(filePath: string): boolean {
    return filePath.startsWith('public/build/') || filePath.startsWith('.weave/');
  }
}
