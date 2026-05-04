import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  BootstrapQuery,
  BootstrapPayload,
  BootstrapEntryCandidate,
  ContextFile,
  ContextConstraint,
  ContextExemplar,
  SubgraphNode,
  SubgraphEdge,
  ContextReason,
  ValidationViolation,
  Convention,
  ConventionPlugin,
  WeaveStatus,
} from './types.js';

type TaskMode = 'implementation' | 'audit_communication' | 'audit_architecture';
type TaskFocus = 'frontend' | 'backend' | 'mixed' | 'tests';

interface TaskProfile {
  mode: TaskMode;
  focus: TaskFocus;
  prefersTests: boolean;
  terms: string[];
  creationLike: boolean;
}

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
  private graphPath: string;

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
    this.graphPath = join(projectRoot, '.weave', 'graph.db');
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
    return this.buildContextBundle([query.start], query);
  }

  /**
   * Agent bootstrap payload: Weave-first context plus compact operating rules.
   * Intended for wrappers/orchestrators that want to inject Weave invisibly.
   */
  bootstrap(query: BootstrapQuery): BootstrapPayload {
    const taskProfile = this.buildTaskProfile(query.task);
    const entryCandidateLimit = query.maxEntryCandidates
      ?? (taskProfile.mode === 'audit_communication' ? 12 : 3);
    const defaultMaxFiles = taskProfile.mode === 'audit_communication'
      ? 12
      : taskProfile.mode === 'implementation' && taskProfile.focus === 'frontend'
        ? 5
        : 8;
    const entryCandidates = this.buildBootstrapEntryCandidates(query, taskProfile, entryCandidateLimit);
    const start = entryCandidates[0]?.file;

    if (!start) {
      throw new Error('Unable to infer a starting file for this task.');
    }

    const context = this.buildContextBundle(
      entryCandidates.map(candidate => candidate.file),
      {
        start,
        scope: query.scope,
        depth: query.depth,
        maxFiles: query.maxFiles ?? defaultMaxFiles,
        maxConstraints: query.maxConstraints,
        maxExemplars: query.maxExemplars,
      },
      taskProfile,
    );
    const guidance = [
      'Use the workingSet as the initial scope for this task.',
      'Treat workingSet items as explicit graph evidence and verify first-hop facts in code before editing.',
      'Treat constraints as advisory repo patterns, not hard rules.',
      'Treat exemplars as nearby examples to imitate when they fit, not as mandatory templates.',
      'Prefer reusing existing functions, actions, requests, components, and composables in the workingSet before inventing new structures.',
    ];
    if (taskProfile.mode === 'audit_communication') {
      guidance.push('This is a communication audit task, so the bundle intentionally includes reverse dependents, runtime communication surfaces, and infrastructure wiring.');
    }
    const fallbackPolicy = [
      'Widen search only if the workingSet is insufficient to complete the task.',
      'Widen search if explicit graph facts do not hold when inspected in code.',
      'If you widen search, do it narrowly and explain what was missing from the Weave bundle.',
    ];

    return {
      task: query.task,
      start,
      startSource: query.start ? 'provided' : 'inferred',
      taskMode: taskProfile.mode,
      entryCandidates,
      context,
      operatingMode: 'weave_first',
      guidance,
      fallbackPolicy,
      prompt: this.buildBootstrapPrompt(
        query.task,
        start,
        entryCandidates,
        context,
        guidance,
        fallbackPolicy,
      ),
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

  /**
   * Ensure the on-disk graph exists and is up to date with current repo files.
   * Returns whether a full init was needed and how many files were refreshed.
   */
  async refresh(): Promise<{ initialized: boolean; updatedFiles: number }> {
    const stats = this.store.getStats();
    const hasGraphData = stats.nodeCount > 0 || stats.edgeCount > 0 || this.store.getAllFileCache().length > 0;

    if (!existsSync(this.graphPath) || !hasGraphData) {
      await this.init();
      return { initialized: true, updatedFiles: 0 };
    }

    const discoveredFiles = await this.watcher.discoverFiles(this.projectRoot);
    const currentFiles = new Set(discoveredFiles);
    const cachedFiles = this.store.getAllFileCache().map(entry => entry.filePath);
    const refreshTargets = new Set<string>();

    for (const file of discoveredFiles) {
      if (this.watcher.isStale(file)) {
        refreshTargets.add(file);
      }
    }

    for (const cachedFile of cachedFiles) {
      if (!currentFiles.has(cachedFile)) {
        refreshTargets.add(cachedFile);
      }
    }

    if (refreshTargets.size > 0) {
      await this.update(Array.from(refreshTargets));
    }

    return { initialized: false, updatedFiles: refreshTargets.size };
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

  private buildContextBundle(
    starts: string[],
    query: ContextBundleQuery,
    taskProfile?: TaskProfile,
  ): ContextBundle {
    const normalizedStarts = starts.map(start => this.toRelativePath(start));
    const result = this.extractCombinedSubgraph(normalizedStarts, query, taskProfile);
    const workingSet = this.buildWorkingSet(result, normalizedStarts, query, taskProfile);

    return {
      workingSet,
      constraints: this.buildContextConstraints(result, query, taskProfile),
      exemplars: this.buildContextExemplars(result, workingSet.map(file => file.file), query, taskProfile),
    };
  }

  private extractCombinedSubgraph(
    starts: string[],
    query: Pick<ContextBundleQuery, 'scope' | 'depth'>,
    taskProfile?: TaskProfile,
  ): SubgraphResult {
    const nodeMap = new Map<number, SubgraphNode>();
    const edgeMap = new Map<string, SubgraphEdge>();

    for (const start of starts) {
      const results: SubgraphResult[] = [this.subgraph.extract({
        start,
        scope: query.scope,
        depth: query.depth,
        options: {
          includeConventions: false,
          includeExemplars: false,
          includeSnippets: false,
        },
      })];

      if (taskProfile?.mode === 'audit_communication' || taskProfile?.mode === 'audit_architecture') {
        results.push(this.subgraph.impact(start));
      }

      for (const result of results) {
        for (const node of result.nodes) {
          nodeMap.set(node.id, node);
        }
        for (const edge of result.edges) {
          edgeMap.set(
            `${edge.from}:${edge.to}:${edge.relationship}:${edge.convention ?? ''}`,
            edge,
          );
        }
      }
    }

    return {
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
    };
  }

  private buildWorkingSet(
    result: SubgraphResult,
    starts: string[],
    query: Pick<ContextBundleQuery, 'maxFiles'>,
    taskProfile?: TaskProfile,
  ): ContextFile[] {
    const startSet = new Set(starts.map(start => this.toRelativePath(start)));
    const primaryStart = starts[0] ? this.toRelativePath(starts[0]) : null;
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
      reasons: Map<string, ContextReason>;
      anchors: SubgraphNode[];
      score: number;
      provenance: 'explicit_graph' | 'task_heuristic';
    }>();

    for (const node of filteredNodes) {
      const entry = this.getOrCreateFileEntry(fileEntries, node.file);
      entry.provenance = 'explicit_graph';
      entry.kinds.add(node.kind);
      if (node.kind !== 'file') {
        entry.score += 5;
        entry.anchors.push(node);
      }
      if (primaryStart && node.file === primaryStart) {
        entry.reasons.set('primary entry candidate', {
          text: 'primary entry candidate',
          provenance: 'explicit_graph',
          confidence: 1,
        });
        entry.score += 100;
      } else if (startSet.has(node.file)) {
        entry.reasons.set('entry candidate', {
          text: 'entry candidate',
          provenance: 'explicit_graph',
          confidence: 0.98,
        });
        entry.score += 75;
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
      fromEntry.provenance = 'explicit_graph';
      toEntry.provenance = 'explicit_graph';

      const reason = {
        text: `connected by ${label}`,
        provenance: 'explicit_graph' as const,
        confidence: this.edgeReasonConfidence(
          edge,
          startSet.has(fromNode.file) || startSet.has(toNode.file),
        ),
      };
      fromEntry.reasons.set(reason.text, reason);
      toEntry.reasons.set(reason.text, reason);

      const edgeScore = startSet.has(fromNode.file) || startSet.has(toNode.file) ? 20 : 10;
      fromEntry.score += edgeScore;
      toEntry.score += edgeScore;
    }

    if (taskProfile) {
      for (const entry of fileEntries.values()) {
        entry.score += this.contextFileTaskBonus(entry.file, taskProfile);
      }
      this.addFrontendImplementationContextFiles(fileEntries, taskProfile, primaryStart);
      this.addHeuristicContextFiles(fileEntries, taskProfile, primaryStart);
    }

    let rankedEntries = Array.from(fileEntries.values())
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

    if (taskProfile?.mode === 'implementation' && taskProfile.focus === 'frontend') {
      const significantTerms = this.significantTaskTerms(taskProfile.terms);
      const structurallyRelevant = (entry: {
        file: string;
        reasons: Map<string, ContextReason>;
      }) => startSet.has(entry.file)
        || entry.reasons.has('primary entry candidate')
        || entry.reasons.has('entry candidate')
        || this.fileTermMatchScore(entry.file, significantTerms) > 0
        || Array.from(entry.reasons.values()).some(reason =>
          reason.text.includes('renders_child')
          || reason.text.includes('uses_composable')
          || reason.text.startsWith('imported by '),
        );

      const lowValueFiltered = rankedEntries.filter(entry =>
        !this.isLowValuePrecedent(entry.file, taskProfile.terms)
        || startSet.has(entry.file)
        || entry.reasons.has('primary entry candidate')
        || entry.reasons.has('entry candidate')
        || this.fileTermMatchScore(entry.file, significantTerms) > 0,
      );
      if (lowValueFiltered.length >= Math.min(maxFiles, 4)) {
        rankedEntries = lowValueFiltered;
      }

      const structureFiltered = rankedEntries.filter(structurallyRelevant);
      if (structureFiltered.length >= Math.min(maxFiles, 4)) {
        rankedEntries = structureFiltered;
      }

      const scoreFloor = Math.max(12, (rankedEntries[0]?.score ?? 0) * 0.18);
      const filteredEntries = rankedEntries.filter(entry =>
        startSet.has(entry.file)
        || entry.reasons.has('primary entry candidate')
        || entry.reasons.has('entry candidate')
        || entry.score >= scoreFloor,
      );
      if (filteredEntries.length >= Math.min(maxFiles, 4)) {
        rankedEntries = filteredEntries;
      }
    }

    return rankedEntries
      .slice(0, maxFiles)
      .map(entry => ({
        file: entry.file,
        kinds: Array.from(entry.kinds).sort(),
        provenance: entry.provenance,
        confidence: this.fileEntryConfidence(entry, primaryStart !== null && entry.file === primaryStart),
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
    taskProfile?: TaskProfile,
  ): ContextConstraint[] {
    const maxConstraints = query.maxConstraints ?? 6;
    const workingKinds = this.getPreferredContextKinds(result, taskProfile);

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
          provenance: 'mined_convention',
          advisory: true,
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
    workingSetFiles: string[],
    query: ContextBundleQuery,
    taskProfile?: TaskProfile,
  ): ContextExemplar[] {
    const maxExemplars = query.maxExemplars ?? 3;
    const workingFiles = new Set(workingSetFiles);
    const preferredKinds = new Set(this.getPreferredContextKinds(result, taskProfile));
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
        provenance: 'structural_similarity',
        confidence: this.kindConventionConfidence(kind),
        nodeId: exemplar.nodeId,
      });
    }

    if (taskProfile?.creationLike && taskProfile.focus !== 'backend') {
      exemplars.push(...this.collectPeerPrecedentExemplars(result, workingFiles, taskProfile));
    }

    const deduped = new Map<string, ContextExemplar>();
    for (const exemplar of exemplars) {
      const key = `${exemplar.kind}:${exemplar.file}`;
      if (!deduped.has(key)) {
        deduped.set(key, exemplar);
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => this.exemplarPriority(b, taskProfile) - this.exemplarPriority(a, taskProfile) || a.file.localeCompare(b.file))
      .slice(0, maxExemplars);
  }

  private collectPeerPrecedentExemplars(
    result: SubgraphResult,
    workingFiles: Set<string>,
    taskProfile: TaskProfile,
  ): ContextExemplar[] {
    const activeFiles = Array.from(new Set(
      result.nodes
        .filter(node => !this.isGeneratedPath(node.file))
        .map(node => node.file),
    ));
    const activeDirectories = new Set(activeFiles.map(file => dirname(file)));
    const importerFiles = new Set<string>();

    for (const file of activeFiles) {
      for (const node of this.store.getNodesByFile(file)) {
        for (const edge of this.store.getEdgesTo(node.id)) {
          if (!['imports', 'uses_composable', 'renders_child'].includes(edge.relationship)) {
            continue;
          }

          const source = this.store.getNodeById(edge.sourceId);
          if (!source || source.filePath === file || this.isGeneratedPath(source.filePath)) {
            continue;
          }

          importerFiles.add(source.filePath);
        }
      }
    }

    const candidateScores = new Map<string, number>();
    for (const importerFile of importerFiles) {
      for (const importerNode of this.store.getNodesByFile(importerFile)) {
        for (const edge of this.store.getEdgesFrom(importerNode.id)) {
          if (!['imports', 'uses_composable', 'renders_child'].includes(edge.relationship)) {
            continue;
          }

          const target = this.store.getNodeById(edge.targetId);
          if (!target || workingFiles.has(target.filePath) || this.isGeneratedPath(target.filePath)) {
            continue;
          }
          if (this.isLowValuePrecedent(target.filePath, taskProfile.terms)) {
            continue;
          }

          let score = candidateScores.get(target.filePath) ?? 0;
          if (activeDirectories.has(dirname(target.filePath))) score += 10;
          if (target.filePath.startsWith('resources/js/composables/')) score += 8;
          if (this.isPatternPeerFile(target.filePath)) score += 5;
          if (target.kind === 'composable' || target.kind === 'function') score += 4;
          if (edge.relationship === 'uses_composable') score += 4;
          if (edge.relationship === 'imports') score += 2;

          for (const term of taskProfile.terms) {
            if (target.filePath.toLowerCase().includes(term)) {
              score += 3;
            }
          }

          if (score > 0) {
            candidateScores.set(target.filePath, score);
          }
        }
      }
    }

    const textPeerScores = this.collectTextImportPeerScores(activeFiles, workingFiles, taskProfile);
    for (const [file, score] of textPeerScores.entries()) {
      candidateScores.set(file, Math.max(candidateScores.get(file) ?? 0, score));
    }

    return Array.from(candidateScores.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([file, score]) => ({
        kind: this.primaryKindForFile(file),
        file,
        reason: 'Nearby precedent imported by the same page/component as the current working set',
        provenance: 'peer_precedent' as const,
        confidence: Math.max(0.72, Math.min(0.9, 0.68 + score / 40)),
        nodeId: this.store.getNodesByFile(file)[0]?.id ?? 0,
      }))
      .filter(exemplar => exemplar.nodeId > 0 && exemplar.kind !== 'file');
  }

  private collectTextImportPeerScores(
    activeFiles: string[],
    workingFiles: Set<string>,
    taskProfile: TaskProfile,
  ): Map<string, number> {
    const activeSet = new Set(activeFiles);
    const activeDirectories = new Set(activeFiles.map(file => dirname(file)));
    const frontendFiles = Array.from(new Set(
      this.store.getAllNodes()
        .map(node => node.filePath)
        .filter(filePath =>
          filePath.startsWith('resources/js/')
          && !this.isGeneratedPath(filePath)
          && /\.(js|ts|vue)$/i.test(filePath),
        ),
    ));
    const scores = new Map<string, number>();

    for (const importerFile of frontendFiles) {
      const content = this.readProjectTextFile(importerFile);
      if (!content) continue;

      const importedFiles = this.extractFrontendImportSources(content)
        .map(source => this.resolveFrontendImport(importerFile, source))
        .filter((file): file is string => file !== null);

      if (!importedFiles.some(file => activeSet.has(file))) {
        continue;
      }

      for (const candidateFile of importedFiles) {
        if (activeSet.has(candidateFile) || workingFiles.has(candidateFile)) {
          continue;
        }
        if (this.isLowValuePrecedent(candidateFile, taskProfile.terms)) {
          continue;
        }

        let score = scores.get(candidateFile) ?? 0;
        if (activeDirectories.has(dirname(candidateFile))) score += 12;
        if (candidateFile.startsWith('resources/js/composables/')) score += 8;
        if (this.isPatternPeerFile(candidateFile)) score += 6;
        score += 6;

        for (const term of taskProfile.terms) {
          if (candidateFile.toLowerCase().includes(term)) {
            score += 3;
          }
        }

        if (score > 0) {
          scores.set(candidateFile, score);
        }
      }
    }

    return scores;
  }

  private getOrCreateFileEntry(
    entries: Map<string, {
      file: string;
      kinds: Set<string>;
      reasons: Map<string, ContextReason>;
      anchors: SubgraphNode[];
      score: number;
      provenance: 'explicit_graph' | 'task_heuristic';
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
      reasons: new Map<string, ContextReason>(),
      anchors: [] as SubgraphNode[],
      score: 0,
      provenance: 'task_heuristic' as const,
    };
    entries.set(file, created);
    return created;
  }

  private sortReasons(reasons: Map<string, ContextReason>): ContextReason[] {
    return Array.from(reasons.values())
      .sort((a, b) => {
        if (a.text === 'primary entry candidate') return -1;
        if (b.text === 'primary entry candidate') return 1;
        if (a.text === 'entry candidate') return -1;
        if (b.text === 'entry candidate') return 1;
        return b.confidence - a.confidence || a.text.localeCompare(b.text);
      })
      .slice(0, 3);
  }

  private getPreferredContextKinds(result: SubgraphResult, taskProfile?: TaskProfile): string[] {
    const availableKinds = new Set(
      result.nodes
        .filter(node => !this.isGeneratedPath(node.file))
        .map(node => node.kind)
        .filter(kind => kind !== 'file'),
    );

    if (taskProfile?.mode === 'audit_communication') {
      return Array.from(availableKinds)
        .sort((a, b) => this.auditBundleKindPriority(b) - this.auditBundleKindPriority(a) || a.localeCompare(b))
        .slice(0, 7);
    }

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

  private exemplarPriority(exemplar: ContextExemplar, taskProfile?: TaskProfile): number {
    let score = exemplar.confidence * 100;

    if (taskProfile?.creationLike && exemplar.provenance === 'peer_precedent') {
      score += 40;
    }

    if (taskProfile?.focus === 'frontend') {
      if (exemplar.file.startsWith('resources/js/composables/')) score += 12;
      else if (exemplar.file.startsWith('resources/js/Components/') || exemplar.file.startsWith('resources/js/Pages/')) score += 8;
      else if (exemplar.file.startsWith('app/')) score -= 12;
    }

    if (taskProfile && this.isLowValuePrecedent(exemplar.file, taskProfile.terms)) {
      score -= 18;
    }

    return score;
  }

  private primaryKindForFile(filePath: string): string {
    const nodes = this.store.getNodesByFile(filePath)
      .filter(node => node.kind !== 'file')
      .sort((a, b) => this.bundleKindPriority(b.kind) - this.bundleKindPriority(a.kind) || a.lineStart - b.lineStart);

    return nodes[0]?.kind ?? 'file';
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
      case 'composable':
        return 58;
      case 'export':
        return 52;
      default:
        return 50;
    }
  }

  private auditBundleKindPriority(kind: string): number {
    switch (kind) {
      case 'action':
        return 100;
      case 'composable':
        return 96;
      case 'inertia_page':
        return 94;
      case 'component':
        return 92;
      case 'method':
        return 88;
      case 'function':
        return 84;
      case 'class':
        return 80;
      case 'export':
        return 78;
      default:
        return this.bundleKindPriority(kind);
    }
  }

  private fileEntryConfidence(
    entry: {
      reasons: Map<string, ContextReason>;
      score: number;
      provenance: 'explicit_graph' | 'task_heuristic';
    },
    isStart: boolean,
  ): number {
    if (isStart) return 1;
    if (entry.provenance === 'task_heuristic') {
      return 0.72;
    }
    const bestReason = Math.max(...Array.from(entry.reasons.values()).map(reason => reason.confidence), 0.75);
    return Math.min(0.98, Math.max(0.75, bestReason));
  }

  private edgeReasonConfidence(edge: { convention: string | null }, isFirstHop: boolean): number {
    if (edge.convention) {
      return isFirstHop ? 0.96 : 0.92;
    }
    return isFirstHop ? 0.93 : 0.88;
  }

  private kindConventionConfidence(kind: string): number {
    const conventions = this.conventionEngine.getConventions(kind);
    if (conventions.length === 0) {
      return 0.7;
    }
    return conventions.reduce((best, convention) => Math.max(best, convention.confidence), 0.7);
  }

  private isGeneratedPath(filePath: string): boolean {
    return filePath.startsWith('public/build/') || filePath.startsWith('.weave/');
  }

  private buildBootstrapPrompt(
    task: string,
    start: string,
    entryCandidates: BootstrapEntryCandidate[],
    context: ContextBundle,
    guidance: string[],
    fallbackPolicy: string[],
  ): string {
    return [
      'You are operating in Weave-first mode.',
      `Task: ${task}`,
      `Entry file: ${start}`,
      '',
      'Inferred entry candidates:',
      ...entryCandidates.map(candidate => `- ${candidate.file} (${Math.round(candidate.confidence * 100)}%): ${candidate.reasons.join('; ')}`),
      '',
      'Use the following context bundle as your initial working set.',
      'Do not broaden repo exploration unless the fallback policy applies.',
      '',
      'Guidance:',
      ...guidance.map(item => `- ${item}`),
      '',
      'Fallback policy:',
      ...fallbackPolicy.map(item => `- ${item}`),
      '',
      'Context bundle:',
      JSON.stringify(context, null, 2),
    ].join('\n');
  }

  private inferEntryCandidates(
    task: string,
    maxCandidates: number,
    taskProfile?: TaskProfile,
  ): BootstrapEntryCandidate[] {
    const profile = taskProfile ?? this.buildTaskProfile(task);
    const terms = profile.terms;
    const prefersTests = profile.prefersTests;
    const taskFocus = profile.focus;
    const allNodes = this.store.getAllNodes()
      .filter(node => !this.isGeneratedPath(node.filePath))
      .filter(node => node.kind !== 'file')
      .filter(node => prefersTests || !node.filePath.startsWith('tests/'));

    const fileScores = new Map<string, {
      bestScore: number;
      matchedTerms: Set<string>;
      reasons: Set<string>;
    }>();

    for (const node of allNodes) {
      const score = this.scoreNodeForTask(node, terms, prefersTests, taskFocus, profile.mode);
      if (score <= 0) {
        continue;
      }

      const entry = fileScores.get(node.filePath) ?? {
        bestScore: 0,
        matchedTerms: new Set<string>(),
        reasons: new Set<string>(),
      };
      entry.bestScore = Math.max(entry.bestScore, score);
      const reason = this.nodeReasonForTask(node, terms);
      if (reason) {
        entry.reasons.add(reason);
      }
      for (const term of terms) {
        if (
          node.filePath.toLowerCase().includes(term)
          || node.symbolName.toLowerCase().includes(term)
        ) {
          entry.matchedTerms.add(term);
        }
      }
      fileScores.set(node.filePath, entry);
    }

    const scored = Array.from(fileScores.entries())
      .sort((a, b) => this.entryCandidateScore(b[1]) - this.entryCandidateScore(a[1]) || a[0].localeCompare(b[0]));

    if (scored.length === 0) {
      const fallback = this.fallbackEntryCandidates(maxCandidates);
      return fallback;
    }

    const maxScore = this.entryCandidateScore(scored[0]?.[1]) ?? 1;
    return scored
      .slice(0, maxCandidates)
      .map(([file, entry]) => ({
        file,
        confidence: Math.max(0.55, Math.min(0.98, this.entryCandidateScore(entry) / maxScore)),
        reasons: Array.from(entry.reasons).slice(0, 3),
      }));
  }

  private entryCandidateScore(entry: {
    bestScore: number;
    matchedTerms: Set<string>;
    reasons: Set<string>;
  } | undefined): number {
    if (!entry) {
      return 0;
    }

    return entry.bestScore
      + Math.min(9, entry.matchedTerms.size * 3)
      + Math.min(3, entry.reasons.size);
  }

  private extractTaskTerms(task: string): string[] {
    const stopwords = new Set([
      'a', 'an', 'and', 'the', 'to', 'for', 'of', 'in', 'on', 'with', 'without',
      'from', 'into', 'by', 'or', 'if', 'is', 'it', 'this', 'that', 'add', 'update',
      'change', 'fix', 'make', 'use', 'new', 'existing', 'line', 'text', 'copy',
      'short', 'small', 'real', 'task', 'build', 'create', 'implement', 'scaffold',
      'wire', 'wiring', 'composable', 'composables',
    ]);

    return task
      .toLowerCase()
      .split(/[^a-z0-9/]+/)
      .map(term => term.trim())
      .filter(term => term.length >= 3)
      .filter(term => !stopwords.has(term));
  }

  private taskPrefersTests(terms: string[]): boolean {
    return terms.some(term => ['test', 'tests', 'spec', 'specs', 'coverage', 'assert'].includes(term));
  }

  private inferTaskMode(task: string, prefersTests: boolean): TaskMode {
    if (prefersTests) {
      return 'implementation';
    }

    const lowerTask = task.toLowerCase();
    const auditSignals = ['audit', 'architecture', 'research', 'trace', 'analyze', 'assessment', 'investigate'];
    const communicationSignals = [
      'communication', 'realtime', 'real-time', 'websocket', 'websockets', 'sse', 'polling',
      'stream', 'events', 'event', 'keepalive', 'transport', 'client',
    ];

    const isAudit = auditSignals.some(signal => lowerTask.includes(signal));
    const isCommunication = communicationSignals.some(signal => lowerTask.includes(signal));

    if (isAudit && isCommunication) {
      return 'audit_communication';
    }
    if (isAudit) {
      return 'audit_architecture';
    }
    return 'implementation';
  }

  private expandTaskTerms(terms: string[], task: string, mode: TaskMode): string[] {
    const expanded = new Set(terms);
    const lowerTask = task.toLowerCase();

    if (mode === 'audit_communication') {
      [
        'campaign',
        'turn',
        'turns',
        'engine',
        'client',
        'event',
        'events',
        'stream',
        'sse',
        'resume',
        'poll',
        'polling',
        'keepalive',
        'combat',
        'status',
        'api',
      ].forEach(term => expanded.add(term));
    }

    if (lowerTask.includes('game engine')) {
      expanded.add('game');
      expanded.add('engine');
    }

    return Array.from(expanded);
  }

  private buildTaskProfile(task: string): TaskProfile {
    const baseTerms = this.extractTaskTerms(task);
    const prefersTests = this.taskPrefersTests(baseTerms);
    const mode = this.inferTaskMode(task, prefersTests);
    const terms = this.expandTaskTerms(baseTerms, task, mode);
    const lowerTask = task.toLowerCase();
    return {
      mode,
      focus: mode === 'audit_communication' ? 'mixed' : this.inferTaskFocus(task, prefersTests),
      prefersTests,
      terms,
      creationLike: /\b(add|build|create|implement|introduce|scaffold|wire|new)\b/.test(lowerTask),
    };
  }

  private inferTaskFocus(
    task: string,
    prefersTests: boolean,
  ): 'frontend' | 'backend' | 'mixed' | 'tests' {
    if (prefersTests) {
      return 'tests';
    }

    const lowerTask = task.toLowerCase();
    const frontendTerms = [
      'page', 'component', 'copy', 'text', 'message', 'label', 'button', 'modal',
      'layout', 'form', 'input', 'header', 'footer', 'tooltip', 'dropdown',
      'screen', 'view', 'ui', 'composable', 'resolver', 'music', 'audio', 'atmosphere',
      'debug', 'panel', 'dice', 'overlay', 'slider', 'toggle',
    ];
    const backendTerms = [
      'action', 'route', 'request', 'validation', 'validate', 'model', 'migration',
      'job', 'event', 'policy', 'controller', 'command', 'queue', 'api', 'endpoint',
      'database',
    ];

    const frontendScore = frontendTerms.filter(term => lowerTask.includes(term)).length;
    const backendScore = backendTerms.filter(term => lowerTask.includes(term)).length;

    if (frontendScore > backendScore) return 'frontend';
    if (backendScore > frontendScore) return 'backend';
    return 'mixed';
  }

  private scoreNodeForTask(
    node: WeaveNode,
    terms: string[],
    prefersTests: boolean,
    taskFocus: 'frontend' | 'backend' | 'mixed' | 'tests',
    taskMode: TaskMode,
  ): number {
    const file = node.filePath.toLowerCase();
    const symbol = node.symbolName.toLowerCase();
    let score = this.bundleKindPriority(node.kind) * 0.05
      + this.pathBootstrapWeight(file, prefersTests, taskFocus, taskMode, terms);

    for (const term of terms) {
      if (file.includes(term)) score += 6;
      if (symbol.includes(term)) score += this.isLowSignalTaskTerm(term) ? 1 : 5;
      if (file.endsWith(`/${term}.vue`) || file.endsWith(`/${term}.php`) || file.endsWith(`/${term}.ts`)) {
        score += 4;
      }
    }

    if (this.isLowValuePrecedent(file, terms)) {
      score -= 18;
    }

    if (node.kind === 'action' && terms.some(term => file.includes(term) || symbol.includes(term))) {
      score += 4;
    }
    if (node.kind === 'inertia_page' && terms.some(term => file.includes(term) || symbol.includes(term))) {
      score += 4;
    }
    if (node.kind === 'component' && terms.some(term => file.includes(term) || symbol.includes(term))) {
      score += 3;
    }

    return score;
  }

  private pathBootstrapWeight(
    filePath: string,
    prefersTests: boolean,
    taskFocus: 'frontend' | 'backend' | 'mixed' | 'tests',
    taskMode: TaskMode,
    terms: string[],
  ): number {
    if (filePath.startsWith('tests/')) {
      return prefersTests ? 10 : -100;
    }
    let score = 0;
    if (filePath.startsWith('app/Actions/')) {
      score += 7 + (taskFocus === 'backend' ? 5 : taskFocus === 'frontend' ? 1 : 3);
      if (taskFocus === 'frontend') score -= 8;
    }
    if (filePath.startsWith('resources/js/Pages/')) {
      score += 6 + (taskFocus === 'frontend' ? 6 : taskFocus === 'backend' ? 1 : 3);
    }
    if (filePath.startsWith('resources/js/Components/')) {
      score += 4 + (taskFocus === 'frontend' ? 5 : 1);
    }
    if (filePath.startsWith('resources/js/composables/')) {
      score += 4 + (taskFocus === 'frontend' ? 7 : 1);
    }
    if (filePath.startsWith('app/Http/Requests/')) {
      score += 4 + (taskFocus === 'backend' ? 4 : 1);
    }
    if (filePath.startsWith('routes/')) {
      score += 3 + (taskFocus === 'backend' ? 3 : 1);
      if (taskFocus === 'frontend') score -= 6;
    }
    if (filePath.startsWith('app/Models/')) {
      score += 3 + (taskFocus === 'backend' ? 3 : 1);
      if (taskFocus === 'frontend') score -= 3;
    }
    if (taskFocus === 'frontend' && filePath.includes('/Admin/')) {
      score -= 12;
    }
    if (taskMode === 'audit_communication') {
      const wantsBrowseSurfaces = this.auditCommunicationWantsBrowseSurfaces(terms);
      if (filePath.startsWith('app/Clients/')) score += 18;
      if (filePath.includes('/Campaign/')) score += 8;
      if (filePath.endsWith('/Campaign/Turns.vue')) score += 18;
      if (filePath.includes('/Actions/') && filePath.includes('/Turn/')) score += 16;
      if (filePath.includes('/Actions/') && filePath.includes('/Events/')) score += 15;
      if (filePath.endsWith('/Turns.vue')) score += 16;
      if (filePath.includes('useCampaignEvents')) score += 16;
      if (filePath.includes('useTurnResume')) score += 16;
      if (filePath.includes('useEngineCombat')) score += 14;
      if (filePath.endsWith('/Scripts/api.js')) score += 15;
      if (filePath === 'routes/api.php') score += 12;
      if (filePath === 'config/services.php') score += 11;
      if (filePath === 'app/Providers/AppServiceProvider.php') score += 10;
      if (filePath.includes('/Admin/') && !terms.includes('admin')) score -= 60;
      if (this.isBrowseSurfacePath(filePath) && !wantsBrowseSurfaces) score -= 36;
      if ((filePath.includes('/Hooks/') || filePath.includes('HookAction')) && !terms.includes('hook')) score -= 14;
      if (filePath.includes('TwoFactor') && !terms.includes('factor')) score -= 10;
      if (filePath.includes('CreateUserAction') && !terms.includes('user')) score -= 8;
    }
    return score;
  }

  private nodeReasonForTask(node: WeaveNode, terms: string[]): string | null {
    for (const term of terms) {
      if (node.filePath.toLowerCase().includes(term)) {
        return `task term "${term}" matches file path`;
      }
      if (node.symbolName.toLowerCase().includes(term) && !this.isLowSignalTaskTerm(term)) {
        return `task term "${term}" matches symbol`;
      }
    }
    return `preferred ${node.kind} candidate`;
  }

  private fallbackEntryCandidates(maxCandidates: number): BootstrapEntryCandidate[] {
    const candidates: BootstrapEntryCandidate[] = [];
    const seenFiles = new Set<string>();

    for (const kind of ['action', 'inertia_page', 'component', 'method']) {
      const nodes = this.store.getNodesByKind(kind)
        .filter(node => !this.isGeneratedPath(node.filePath))
        .filter(node => kind !== 'method' || node.symbolName.endsWith('::asController'));

      for (const node of nodes) {
        if (seenFiles.has(node.filePath)) continue;
        seenFiles.add(node.filePath);
        candidates.push({
          file: node.filePath,
          confidence: 0.4,
          reasons: [`fallback ${kind} candidate`],
        });
        if (candidates.length >= maxCandidates) {
          return candidates;
        }
      }
    }

    return candidates;
  }

  private buildBootstrapEntryCandidates(
    query: BootstrapQuery,
    taskProfile: TaskProfile,
    maxCandidates: number,
  ): BootstrapEntryCandidate[] {
    const merged = new Map<string, BootstrapEntryCandidate>();
    const add = (candidate: BootstrapEntryCandidate) => {
      const existing = merged.get(candidate.file);
      if (!existing || candidate.confidence > existing.confidence) {
        merged.set(candidate.file, candidate);
      }
    };

    if (query.start) {
      add({
        file: this.toRelativePath(query.start),
        confidence: 1,
        reasons: ['provided by caller'],
      });
    }

    const inferred = this.inferEntryCandidates(query.task, maxCandidates, taskProfile);
    for (const candidate of inferred) {
      add(candidate);
    }

    const frontendBridgeCandidates = this.inferFrontendBridgeCandidates(
      Array.from(merged.values()),
      taskProfile,
      maxCandidates,
    );
    for (const candidate of frontendBridgeCandidates) {
      add(candidate);
    }

    if (query.start && (taskProfile.mode === 'audit_communication' || taskProfile.mode === 'audit_architecture')) {
      const impacted = this.inferImpactAdjacentCandidates(query.start, taskProfile, maxCandidates);
      for (const candidate of impacted) {
        add(candidate);
      }
    }

    if (taskProfile.mode === 'audit_communication') {
      const communication = this.inferCommunicationSurfaceCandidates(maxCandidates, taskProfile);
      for (const candidate of communication) {
        add(candidate);
      }
    }

    const candidates = Array.from(merged.values())
      .sort((a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file))
      .slice(0, maxCandidates * 2);

    return this.filterBootstrapEntryCandidates(candidates, query, taskProfile)
      .slice(0, maxCandidates);
  }

  private filterBootstrapEntryCandidates(
    candidates: BootstrapEntryCandidate[],
    query: BootstrapQuery,
    taskProfile: TaskProfile,
  ): BootstrapEntryCandidate[] {
    const frontendFiltered = this.filterFrontendImplementationCandidates(candidates, query, taskProfile);

    if (taskProfile.mode !== 'audit_communication' || taskProfile.terms.includes('admin')) {
      return this.filterBrowseEntryCandidates(frontendFiltered, query, taskProfile);
    }

    const providedStart = query.start ? this.toRelativePath(query.start) : null;
    const preferred = frontendFiltered.filter(candidate =>
      candidate.file === providedStart || !candidate.file.includes('/Admin/'),
    );

    return this.filterBrowseEntryCandidates(preferred.length > 0 ? preferred : frontendFiltered, query, taskProfile);
  }

  private filterFrontendImplementationCandidates(
    candidates: BootstrapEntryCandidate[],
    query: BootstrapQuery,
    taskProfile: TaskProfile,
  ): BootstrapEntryCandidate[] {
    if (taskProfile.mode !== 'implementation' || taskProfile.focus !== 'frontend') {
      return candidates;
    }

    const providedStart = query.start ? this.toRelativePath(query.start) : null;
    const preferred = candidates.filter(candidate =>
      candidate.file === providedStart
      || !(
        candidate.file.startsWith('app/Actions/')
        || candidate.file.startsWith('routes/')
        || candidate.file.startsWith('app/Models/')
        || candidate.file.startsWith('app/Http/')
      ),
    );

    return preferred.length > 0 ? preferred : candidates;
  }

  private inferImpactAdjacentCandidates(
    start: string,
    taskProfile: TaskProfile,
    maxCandidates: number,
  ): BootstrapEntryCandidate[] {
    const impact = this.subgraph.impact(start);
    const scored = new Map<string, number>();

    for (const node of impact.nodes) {
      if (node.file === this.toRelativePath(start) || this.isGeneratedPath(node.file)) {
        continue;
      }
      const current = scored.get(node.file) ?? 0;
      const kindBonus = this.auditBundleKindPriority(node.kind) * 0.05;
      scored.set(node.file, Math.max(current, this.contextFileTaskBonus(node.file, taskProfile) + kindBonus + 8));
    }

    const sorted = Array.from(scored.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxCandidates);

    const maxScore = sorted[0]?.[1] ?? 1;
    return sorted.map(([file, score]) => ({
      file,
      confidence: Math.max(0.58, Math.min(0.96, score / maxScore)),
      reasons: ['reverse dependents of the provided start'],
    }));
  }

  private inferCommunicationSurfaceCandidates(
    maxCandidates: number,
    taskProfile?: TaskProfile,
  ): BootstrapEntryCandidate[] {
    const scored = new Map<string, number>();
    const wantsBrowseSurfaces = taskProfile
      ? this.auditCommunicationWantsBrowseSurfaces(taskProfile.terms)
      : false;
    const candidates = this.store.getAllNodes()
      .filter(node => !this.isGeneratedPath(node.filePath))
      .filter(node => !node.filePath.startsWith('tests/'))
      .filter(node => node.kind !== 'file');

    for (const node of candidates) {
      const file = node.filePath;
      let score = 0;

      if (file.endsWith('/Campaign/Turns.vue')) score += 44;
      if (file.includes('useCampaignEvents')) score += 40;
      if (file.includes('useTurnResume')) score += 38;
      if (file.includes('useEngineCombat')) score += 39;
      if (file.endsWith('/Scripts/api.js')) score += 38;
      if (file === 'routes/api.php') score += 22;
      if (file.includes('/Campaign/Events/')) score += 20;
      if (file.includes('/Campaign/Turn/')) score += 18;
      if (this.isBrowseSurfacePath(file) && !wantsBrowseSurfaces) score -= 30;

      if (score <= 0) {
        continue;
      }

      scored.set(file, Math.max(scored.get(file) ?? 0, score));
    }

    const sorted = Array.from(scored.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxCandidates);

    const maxScore = sorted[0]?.[1] ?? 1;
    return sorted.map(([file, score]) => ({
      file,
      confidence: Math.max(0.58, Math.min(0.94, score / maxScore)),
      reasons: ['communication surface candidate'],
    }));
  }

  private inferFrontendBridgeCandidates(
    existingCandidates: BootstrapEntryCandidate[],
    taskProfile: TaskProfile,
    maxCandidates: number,
  ): BootstrapEntryCandidate[] {
    if (taskProfile.mode !== 'implementation' || taskProfile.focus !== 'frontend') {
      return [];
    }

    const seed = existingCandidates
      .filter(candidate => candidate.file.startsWith('resources/js/') && candidate.file.endsWith('.vue'))
      .sort((a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file))[0];

    if (!seed) {
      return [];
    }

    const seedContent = this.readProjectTextFile(seed.file);
    if (!seedContent) {
      return [];
    }

    const componentName = basename(seed.file).replace(/\.[^.]+$/, '');
    const emittedEvents = this.extractVueEmittedEvents(seedContent);
    const significantTerms = this.significantTaskTerms(taskProfile.terms);
    const existingFiles = new Set(existingCandidates.map(candidate => candidate.file));
    const bridgeScores = new Map<string, { score: number; reasons: Set<string> }>();
    const peerScores = new Map<string, { score: number; reasons: Set<string> }>();
    const frontendVueFiles = Array.from(new Set(
      this.store.getAllNodes()
        .map(node => node.filePath)
        .filter(filePath =>
          filePath.startsWith('resources/js/')
          && filePath.endsWith('.vue')
          && !this.isGeneratedPath(filePath),
        ),
    ));

    for (const file of frontendVueFiles) {
      if (file === seed.file) continue;
      const content = this.readProjectTextFile(file);
      if (!content) continue;

      const importedFiles = this.extractFrontendImportSources(content)
        .map(source => this.resolveFrontendImport(file, source))
        .filter((resolved): resolved is string => resolved !== null);

      let score = 0;
      const reasons = new Set<string>();

      if (importedFiles.includes(seed.file)) {
        score += 26;
        reasons.add(`imports ${basename(seed.file)}`);
      }
      if (this.fileUsesVueComponent(content, componentName)) {
        score += 10;
        reasons.add(`renders <${componentName}>`);
      }
      for (const eventName of emittedEvents) {
        if (this.fileListensForVueEvent(content, eventName)) {
          score += 28;
          reasons.add(`listens for "${eventName}"`);
        }
      }
      score += this.fileTermMatchScore(file, significantTerms);

      if (score <= 0) {
        continue;
      }

      bridgeScores.set(file, { score, reasons });
      this.collectFrontendBridgeImportCandidates(
        file,
        significantTerms,
        taskProfile,
        existingFiles,
        peerScores,
        0,
      );
    }

    const bridgeCandidates = Array.from(bridgeScores.entries())
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
      .slice(0, 2);
    const peerCandidates = Array.from(peerScores.entries())
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
      .slice(0, Math.max(2, maxCandidates));

    const combined: BootstrapEntryCandidate[] = [];
    for (const [file, entry] of bridgeCandidates) {
      combined.push({
        file,
        confidence: Math.max(0.8, Math.min(0.95, 0.72 + entry.score / 80)),
        reasons: Array.from(entry.reasons).slice(0, 3),
      });
      existingFiles.add(file);
    }

    for (const [file, entry] of peerCandidates) {
      if (existingFiles.has(file)) {
        continue;
      }
      combined.push({
        file,
        confidence: Math.max(0.68, Math.min(0.84, 0.56 + entry.score / 140)),
        reasons: Array.from(entry.reasons).slice(0, 3),
      });
      existingFiles.add(file);
    }

    return combined.slice(0, maxCandidates);
  }

  private contextFileTaskBonus(filePath: string, taskProfile: TaskProfile): number {
    let score = this.pathBootstrapWeight(
      filePath,
      taskProfile.prefersTests,
      taskProfile.focus,
      taskProfile.mode,
      taskProfile.terms,
    );

    for (const term of taskProfile.terms) {
      if (filePath.toLowerCase().includes(term)) {
        score += 4;
      }
    }

    if (this.isLowValuePrecedent(filePath, taskProfile.terms)) {
      score -= 18;
    }

    return score;
  }

  private filterBrowseEntryCandidates(
    candidates: BootstrapEntryCandidate[],
    query: BootstrapQuery,
    taskProfile: TaskProfile,
  ): BootstrapEntryCandidate[] {
    if (taskProfile.mode !== 'audit_communication' || this.auditCommunicationWantsBrowseSurfaces(taskProfile.terms)) {
      return candidates;
    }

    const providedStart = query.start ? this.toRelativePath(query.start) : null;
    const preferred = candidates.filter(candidate =>
      candidate.file === providedStart || !this.isBrowseSurfacePath(candidate.file),
    );

    return preferred.length > 0 ? preferred : candidates;
  }

  private auditCommunicationWantsBrowseSurfaces(terms: string[]): boolean {
    return terms.some(term => [
      'list',
      'index',
      'browse',
      'history',
      'pagination',
      'paginate',
      'timeline',
      'feed',
    ].includes(term));
  }

  private isBrowseSurfacePath(filePath: string): boolean {
    return /\/(?:List|Index|Browse|History)[^/]*\.(?:php|vue|ts|js)$/i.test(filePath);
  }

  private isPatternPeerFile(filePath: string): boolean {
    return /(Preset|Presets|Resolver|Manifest|Mapper|Engine)\.(?:js|ts|vue)$/i.test(filePath);
  }

  private isLowSignalTaskTerm(term: string): boolean {
    return [
      'test',
      'tests',
      'debug',
      'panel',
      'control',
      'controls',
      'roll',
      'feature',
      'features',
      'component',
      'components',
      'page',
      'pages',
    ].includes(term);
  }

  private significantTaskTerms(terms: string[]): string[] {
    const filtered = terms.filter(term => !this.isLowSignalTaskTerm(term));
    return filtered.length > 0 ? filtered : terms;
  }

  private isLowValuePrecedent(filePath: string, terms: string[]): boolean {
    const lower = filePath.toLowerCase();
    if (lower.includes('mock') && !terms.includes('mock')) return true;
    if (lower.includes('/scripts/api.') && !terms.some(term => ['api', 'network', 'request', 'http'].includes(term))) return true;
    if (lower.includes('constant') && !terms.some(term => ['constant', 'combat', 'battle'].includes(term))) return true;
    return false;
  }

  private extractFrontendImportSources(source: string): string[] {
    return Array.from(source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      .map(match => match[1]);
  }

  private extractVueEmittedEvents(source: string): string[] {
    const events = new Set<string>();
    const addMatches = (text: string) => {
      for (const match of text.matchAll(/['"]([^'"]+)['"]/g)) {
        if (match[1]) {
          events.add(match[1]);
        }
      }
    };

    for (const match of source.matchAll(/defineEmits\s*\(\s*\[([\s\S]*?)\]\s*\)/g)) {
      addMatches(match[1]);
    }
    for (const match of source.matchAll(/emit\s*\(\s*['"]([^'"]+)['"]/g)) {
      if (match[1]) {
        events.add(match[1]);
      }
    }

    return Array.from(events);
  }

  private fileUsesVueComponent(source: string, componentName: string): boolean {
    const escaped = componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<${escaped}(?:\\s|>|/)`).test(source);
  }

  private fileListensForVueEvent(source: string, eventName: string): boolean {
    const escaped = eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:@|v-on:)${escaped}(?=[\\s=>])`).test(source);
  }

  private fileTermMatchScore(filePath: string, terms: string[]): number {
    const lower = filePath.toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (lower.includes(term)) {
        score += term.length >= 5 ? 10 : 7;
      }
    }

    return score;
  }

  private collectFrontendBridgeImportCandidates(
    importerFile: string,
    significantTerms: string[],
    taskProfile: TaskProfile,
    existingFiles: Set<string>,
    scores: Map<string, { score: number; reasons: Set<string> }>,
    depth: number,
  ): void {
    if (depth > 1) {
      return;
    }

    const content = this.readProjectTextFile(importerFile);
    if (!content) {
      return;
    }

    const importedFiles = this.extractFrontendImportSources(content)
      .map(source => this.resolveFrontendImport(importerFile, source))
      .filter((file): file is string => file !== null);

    for (const file of importedFiles) {
      if (existingFiles.has(file) || this.isGeneratedPath(file)) {
        continue;
      }

      let score = this.fileTermMatchScore(file, significantTerms);
      if (score <= 0 && depth > 0) {
        continue;
      }

      if (file.startsWith('resources/js/Components/')) score += 14;
      else if (file.startsWith('resources/js/composables/')) score += 6;
      else if (file.startsWith('resources/js/utils/')) score += 7;
      else if (file.startsWith('resources/js/Pages/')) score += 6;

      if (this.isLowValuePrecedent(file, taskProfile.terms)) {
        score -= 12;
      }
      if (score <= 0) {
        continue;
      }

      const existing = scores.get(file) ?? { score: 0, reasons: new Set<string>() };
      existing.score = Math.max(existing.score, score + (depth === 0 ? 10 : 0));
      existing.reasons.add(
        depth === 0
          ? `imported by ${basename(importerFile)} and matches task terms`
          : `imported by ${basename(importerFile)} through a related frontend bridge`,
      );
      scores.set(file, existing);

      existingFiles.add(file);
      this.collectFrontendBridgeImportCandidates(
        file,
        significantTerms,
        taskProfile,
        existingFiles,
        scores,
        depth + 1,
      );
      existingFiles.delete(file);
    }
  }

  private resolveFrontendImport(importerFile: string, source: string): string | null {
    if (!source.startsWith('@/') && !source.startsWith('./') && !source.startsWith('../')) {
      return null;
    }

    const candidates: string[] = [];
    if (source.startsWith('@/')) {
      candidates.push(`resources/js/${source.slice(2)}`);
    } else {
      candidates.push(join(dirname(importerFile), source).replace(/\\/g, '/'));
    }

    for (const candidate of candidates.flatMap(path => this.expandFrontendImportCandidates(path))) {
      if (existsSync(join(this.projectRoot, candidate))) {
        return candidate;
      }
    }

    return null;
  }

  private expandFrontendImportCandidates(path: string): string[] {
    if (/\.(js|ts|vue)$/i.test(path)) {
      return [path];
    }

    return [
      `${path}.js`,
      `${path}.ts`,
      `${path}.vue`,
      join(path, 'index.js').replace(/\\/g, '/'),
      join(path, 'index.ts').replace(/\\/g, '/'),
      join(path, 'index.vue').replace(/\\/g, '/'),
    ];
  }

  private readProjectTextFile(filePath: string): string | null {
    const absolute = join(this.projectRoot, filePath);
    if (!existsSync(absolute)) {
      return null;
    }

    try {
      return readFileSync(absolute, 'utf-8');
    } catch {
      return null;
    }
  }

  private addHeuristicContextFiles(
    fileEntries: Map<string, {
      file: string;
      kinds: Set<string>;
      reasons: Map<string, ContextReason>;
      anchors: SubgraphNode[];
      score: number;
      provenance: 'explicit_graph' | 'task_heuristic';
    }>,
    taskProfile: TaskProfile,
    primaryStart: string | null,
  ): void {
    if (taskProfile.mode !== 'audit_communication') {
      return;
    }

    const candidateFiles = [
      'config/services.php',
      'app/Providers/AppServiceProvider.php',
    ];

    const hasClientFocus = primaryStart?.startsWith('app/Clients/')
      || Array.from(fileEntries.keys()).some(file => file.startsWith('app/Clients/'));
    if (!hasClientFocus) {
      return;
    }

    for (const file of candidateFiles) {
      const absolute = join(this.projectRoot, file);
      if (!existsSync(absolute) || fileEntries.has(file)) {
        continue;
      }

      const entry = this.getOrCreateFileEntry(fileEntries, file);
      entry.provenance = 'task_heuristic';
      entry.score += file === 'config/services.php' ? 500 : 220;
      entry.reasons.set('infrastructure wiring for client/service configuration', {
        text: 'infrastructure wiring for client/service configuration',
        provenance: 'task_heuristic',
        confidence: 0.72,
      });
    }
  }

  private addFrontendImplementationContextFiles(
    fileEntries: Map<string, {
      file: string;
      kinds: Set<string>;
      reasons: Map<string, ContextReason>;
      anchors: SubgraphNode[];
      score: number;
      provenance: 'explicit_graph' | 'task_heuristic';
    }>,
    taskProfile: TaskProfile,
    primaryStart: string | null,
  ): void {
    if (taskProfile.mode !== 'implementation' || taskProfile.focus !== 'frontend' || !primaryStart) {
      return;
    }

    const candidates = this.inferFrontendBridgeCandidates([
      {
        file: primaryStart,
        confidence: 1,
        reasons: ['primary entry candidate'],
      },
    ], taskProfile, 6);
    const significantTerms = this.significantTaskTerms(taskProfile.terms);

    for (const candidate of candidates) {
      const entry = this.getOrCreateFileEntry(fileEntries, candidate.file);
      if (entry.provenance !== 'explicit_graph') {
        entry.provenance = 'task_heuristic';
      }
      entry.score += candidate.file.endsWith('.vue') ? 52 : 42;
      entry.kinds.add(this.primaryKindForFile(candidate.file));
      for (const reason of candidate.reasons) {
        entry.reasons.set(reason, {
          text: reason,
          provenance: 'task_heuristic',
          confidence: candidate.confidence,
        });
      }

      const content = this.readProjectTextFile(candidate.file);
      if (!content) {
        continue;
      }

      const importedFiles = this.extractFrontendImportSources(content)
        .map(source => this.resolveFrontendImport(candidate.file, source))
        .filter((file): file is string => file !== null);

      for (const importedFile of importedFiles) {
        if (this.isGeneratedPath(importedFile) || this.isLowValuePrecedent(importedFile, taskProfile.terms)) {
          continue;
        }
        if (this.fileTermMatchScore(importedFile, significantTerms) <= 0) {
          continue;
        }

        const importedEntry = this.getOrCreateFileEntry(fileEntries, importedFile);
        if (importedEntry.provenance !== 'explicit_graph') {
          importedEntry.provenance = 'task_heuristic';
        }
        importedEntry.kinds.add(this.primaryKindForFile(importedFile));
        importedEntry.score += importedFile.endsWith('.vue') ? 46 : 36;
        const reason = `imported by ${basename(candidate.file)} and matches task terms`;
        importedEntry.reasons.set(reason, {
          text: reason,
          provenance: 'task_heuristic',
          confidence: Math.max(0.76, candidate.confidence - 0.06),
        });
      }
    }
  }
}
