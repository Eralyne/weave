import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { isTestFilePath, toProjectRelative } from './path-utils.js';
import type {
  WeaveConfig,
  WeaveNode,
  WeaveEdge,
  SubgraphQuery,
  SubgraphOptions,
  SubgraphResult,
  ContextBundleQuery,
  ContextBundle,
  BootstrapQuery,
  BootstrapPayload,
  BootstrapEntryCandidate,
  BootstrapExistingFileEdge,
  BootstrapPatternEvidence,
  BootstrapPlannedFileExemplar,
  BootstrapPlannedFilePattern,
  BootstrapSpecContext,
  BootstrapSpecLineAnchoredQuery,
  BootstrapSpecLineReference,
  BootstrapWarning,
  QuerySpecContext,
  ContextFile,
  ContextConstraint,
  ContextExemplar,
  SubgraphNode,
  SubgraphEdge,
  ContextReason,
  ValidationViolation,
  ValidationResult,
  ValidationSummary,
  Convention,
  ConventionPlugin,
  WeaveStatus,
  IndexingDiagnostics,
} from './types.js';

type TaskMode = 'implementation' | 'audit_communication' | 'audit_architecture';
type TaskFocus = 'frontend' | 'backend' | 'mixed' | 'tests';
type ContextProvenance = ContextReason['provenance'];

interface TaskProfile {
  mode: TaskMode;
  focus: TaskFocus;
  prefersTests: boolean;
  terms: string[];
  endpointLiterals: string[];
  specContext: BootstrapSpecContext | null;
  creationLike: boolean;
}

interface ExemplarOptions {
  routeMethod?: string;
  subKind?: string;
}

interface ValidationOptions {
  fromSpec?: string;
  fromSpecText?: string;
  changedOnly?: boolean;
  stagedOnly?: boolean;
  includeSpecCoverage?: boolean;
}

interface PlannedFileExemplarCandidate {
  nodeId: number;
  file: string;
  reason: string;
  confidence: number;
  coMentionConfidence: number;
  shapeMatchConfidence: number;
  confidenceReason: string;
}

interface IndexerFingerprint {
  version: number;
  hash: string;
  plugins: string[];
  generatedAt: string;
}

const INDEXER_FINGERPRINT_VERSION = 2;
const PLANNED_EXEMPLAR_CONFIDENCE_FLOOR = 0.6;

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
  private fingerprintPath: string;

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
    this.fingerprintPath = join(projectRoot, '.weave', 'index-fingerprint.json');
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
    this.persistIndexerFingerprint(this.computeIndexerFingerprint(plugins));

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
        if (this.shouldIgnoreUnresolvedL2Edge(edge, details)) {
          continue;
        }
        this.diagnostics.recordL2EdgeSkipped(
          relativeFilePath,
          edge.relationship,
          reason ?? 'unresolved_edge',
          details,
          this.classifyUnresolvedL2Edge(edge, details),
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
    const moduleSpecifier = meta.moduleSpecifier as string | undefined;
    const importedNames = Array.isArray(meta.importedNames)
      ? meta.importedNames.filter((value): value is string => typeof value === 'string')
      : [];
    const sourceFile = meta.sourceFile as string | undefined;
    const sourceLanguage = this.parser.getLanguage(filePath);

    const sourceIds: number[] = [];
    if (sourceSymbol) {
      const resolved = this.resolveSymbolId(sourceSymbol, localNodes, sourceLanguage);
      if (resolved !== undefined) {
        sourceIds.push(resolved);
      }
    } else if (sourceFile ?? filePath) {
      sourceIds.push(this.ensureFileNodeId(sourceFile ?? filePath));
    }

    const targetIds = new Set<number>();
    if (targetSymbol) {
      const resolved = this.resolveSymbolId(targetSymbol, localNodes, sourceLanguage);
      if (resolved !== undefined) {
        targetIds.add(resolved);
      }
    } else if (importedSymbol) {
      const resolved = this.resolveSymbolId(importedSymbol, localNodes, sourceLanguage);
      if (resolved !== undefined) {
        targetIds.add(resolved);
      }
    } else {
      for (const importedName of importedNames) {
        const resolved = this.resolveSymbolId(importedName, localNodes, sourceLanguage);
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
          moduleSpecifier: moduleSpecifier ?? null,
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

  private shouldIgnoreUnresolvedL2Edge(
    edge: Partial<WeaveEdge>,
    details?: Record<string, unknown>,
  ): boolean {
    if (edge.relationship === 'imports') {
      const imported = String(details?.importedSymbol ?? '');
      const moduleSpecifier = String(details?.moduleSpecifier ?? '');
      return (imported.length > 0 && this.isExternalImportSymbol(imported))
        || this.isExternalModuleSpecifier(moduleSpecifier);
    }

    if (edge.relationship !== 'calls') {
      return false;
    }

    const target = String(details?.targetSymbol ?? details?.importedSymbol ?? '');
    if (!target) {
      return false;
    }
    if (target.length <= 1) {
      return true;
    }

    if (target.includes('.') && !target.includes('::')) {
      return true;
    }
    if (target.includes('().') || target.includes('::factory')) {
      return true;
    }
    if (this.callTargetImportedFromExternalModule(target, String(details?.sourceFile ?? ''))) {
      return true;
    }

    return this.isKnownExternalCall(target);
  }

  private classifyUnresolvedL2Edge(
    edge: Partial<WeaveEdge>,
    details?: Record<string, unknown>,
  ): 'external_dependency' | 'internal_unresolved' | 'unknown' {
    if (!details) {
      return 'unknown';
    }

    if (edge.relationship === 'imports') {
      const moduleSpecifier = String(details.moduleSpecifier ?? '');
      const importedSymbol = String(details.importedSymbol ?? '');
      if (this.isExternalModuleSpecifier(moduleSpecifier) || this.isExternalImportSymbol(importedSymbol)) {
        return 'external_dependency';
      }
      return 'internal_unresolved';
    }

    if (edge.relationship === 'calls') {
      const target = String(details.targetSymbol ?? details.importedSymbol ?? '');
      if (!target) {
        return 'unknown';
      }
      if (
        this.isKnownExternalCall(target)
        || (target.includes('.') && !target.includes('::'))
        || this.callTargetImportedFromExternalModule(target, String(details.sourceFile ?? ''))
      ) {
        return 'external_dependency';
      }
      if (!target.includes('::') && !target.includes('\\') && /^[a-z_$]/.test(target)) {
        return 'unknown';
      }
      return 'internal_unresolved';
    }

    const targetSymbol = String(details.targetSymbol ?? details.importedSymbol ?? '');
    if (this.isExternalImportSymbol(targetSymbol)) {
      return 'external_dependency';
    }
    return 'internal_unresolved';
  }

  private isExternalImportSymbol(symbol: string): boolean {
    if (symbol.startsWith('.')) {
      return false;
    }

    if (/^(?:App|Src)\\/.test(symbol)) {
      return false;
    }
    if (symbol.includes('\\') && !/^(?:App|Src)\\/.test(symbol)) {
      return true;
    }
    if (this.isKnownExternalClassSymbol(symbol)) {
      return true;
    }

    return [
      'Illuminate\\',
      'Inertia\\',
      'Laravel\\',
      'Lorisleiva\\',
      'Symfony\\',
      'Carbon\\',
      'Spatie\\',
      'Pest\\',
      'PHPUnit\\',
      'Vue',
      '@',
    ].some(prefix => symbol.startsWith(prefix));
  }

  private isExternalModuleSpecifier(moduleSpecifier: string): boolean {
    if (!moduleSpecifier) {
      return false;
    }
    return !moduleSpecifier.startsWith('.')
      && !moduleSpecifier.startsWith('/')
      && !moduleSpecifier.startsWith('@/')
      && !moduleSpecifier.startsWith('~/');
  }

  private isKnownExternalCall(symbol: string): boolean {
    if (/^(?:app|collect)\s*\(/.test(symbol)) {
      return true;
    }

    const staticOwner = symbol.includes('::') ? this.getShortSymbolName(symbol.split('::')[0] ?? '') : '';
    if (staticOwner && this.isKnownExternalStaticOwner(staticOwner)) {
      return true;
    }

    const normalized = symbol
      .replace(/\(.*\)/, '')
      .split('::')
      .pop()
      ?.split('.')
      .pop()
      ?.toLowerCase()
      ?? symbol.toLowerCase();
    return new Set([
      'actingas',
      'array_filter',
      'array_map',
      'array_merge',
      'array_values',
      'array_key_exists',
      'app',
      'assertsent',
      'auth',
      'back',
      'boolean',
      'cancelframe',
      'cancelanimationframe',
      'clearinterval',
      'cache',
      'cleartimeout',
      'collect',
      'computed',
      'config',
      'count',
      'dd',
      'delay',
      'dump',
      'emit',
      'empty',
      'env',
      'explode',
      'fetch',
      'file_get_contents',
      'filled',
      'float',
      'fract',
      'in_array',
      'isset',
      'is_array',
      'json_decode',
      'json_encode',
      'strlen',
      'strtolower',
      'strtoupper',
      'substr',
      'preg_match',
      'preg_replace',
      'markraw',
      'nexttick',
      'number',
      'now',
      'onmounted',
      'onunmounted',
      'put',
      'resolve',
      'requestanimationframe',
      'redirect',
      'ref',
      'render',
      'request',
      'response',
      'route',
      'setinterval',
      'setup',
      'settimeout',
      'sin',
      'string',
      'tovalue',
      'ucfirst',
      'uniform',
      'url',
      'vec2',
      'vec3',
      'view',
      'watch',
      '__',
    ]).has(normalized);
  }

  private isKnownExternalStaticOwner(symbol: string): boolean {
    return new Set([
      'Artisan',
      'Auth',
      'Bus',
      'Cache',
      'DB',
      'Event',
      'File',
      'Gate',
      'Google2FA',
      'Hash',
      'Http',
      'Inertia',
      'Limit',
      'Log',
      'Mail',
      'Notification',
      'Mockery',
      'UploadedFile',
      'Password',
      'Process',
      'Queue',
      'RateLimiter',
      'Route',
      'Rule',
      'Schema',
      'Socialite',
      'Storage',
      'Str',
      'URL',
      'Validator',
      'parent',
    ]).has(symbol);
  }

  private callTargetImportedFromExternalModule(target: string, sourceFile: string): boolean {
    if (!sourceFile) {
      return false;
    }
    const callName = this.getShortSymbolName(target.split('::').pop() ?? target)
      .split('.')
      .pop()
      ?? target;
    const relativeFile = this.toRelativePath(sourceFile);
    const source = this.readProjectTextFile(relativeFile);
    if (!source) {
      return false;
    }
    const importRegex = /import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(importRegex)) {
      const clause = match[1]?.trim() ?? '';
      const moduleSpecifier = match[2]?.trim() ?? '';
      if (!this.isExternalModuleSpecifier(moduleSpecifier)) {
        continue;
      }
      if (this.importClauseContainsSymbol(clause, callName)) {
        return true;
      }
    }
    return false;
  }

  private importClauseContainsSymbol(clause: string, symbolName: string): boolean {
    const defaultPart = clause.split(',')[0]?.trim();
    if (defaultPart === symbolName) {
      return true;
    }
    const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceMatch?.[1] === symbolName) {
      return true;
    }
    const namedMatch = clause.match(/\{([^}]+)\}/);
    if (!namedMatch) {
      return false;
    }
    return namedMatch[1]
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .some(part => {
        const local = part.match(/\bas\s+([A-Za-z_$][\w$]*)$/)?.[1] ?? part;
        return local.trim() === symbolName;
      });
  }

  private isKnownExternalClassSymbol(symbol: string): boolean {
    const short = this.getShortSymbolName(symbol);
    return new Set([
      'ActionRequest',
      'Authenticatable',
      'BaseTestCase',
      'Blueprint',
      'Closure',
      'Command',
      'Exception',
      'Factory',
      'FormRequest',
      'LengthAwarePaginator',
      'Mailable',
      'Migration',
      'Middleware',
      'Model',
      'RedirectResponse',
      'Request',
      'Response',
      'Seeder',
      'ServiceProvider',
      'TelescopeApplicationServiceProvider',
      'Throwable',
    ]).has(short);
  }

  /**
   * Look up a symbol's node ID: first in locally upserted nodes, then in the store.
   */
  private resolveSymbolId(
    symbolName: string,
    localNodes: Map<string, WeaveNode>,
    sourceLanguage?: string,
  ): number | undefined {
    const local = localNodes.get(symbolName);
    if (local) return local.id;

    const storeNodes = this.compatibleSymbolNodes(
      this.store.findNodeBySymbol(symbolName),
      sourceLanguage,
    );
    if (storeNodes.length > 0) return storeNodes[0].id;

    const shortName = symbolName.includes('.') && !symbolName.includes('::')
      ? symbolName
      : this.getShortSymbolName(symbolName);
    if (shortName !== symbolName) {
      const localShort = localNodes.get(shortName);
      if (localShort) return localShort.id;

      const shortNodes = this.compatibleSymbolNodes(
        this.store.findNodeBySymbol(shortName),
        sourceLanguage,
      );
      if (shortNodes.length > 0) return shortNodes[0].id;
    }

    const scopedOwner = this.scopedCallOwner(symbolName);
    if (scopedOwner && !this.isKnownExternalStaticOwner(scopedOwner)) {
      const localOwner = localNodes.get(scopedOwner);
      if (localOwner) return localOwner.id;

      const ownerNodes = this.compatibleSymbolNodes(
        this.store.findNodeBySymbol(scopedOwner),
        sourceLanguage,
      );
      if (ownerNodes.length > 0) return ownerNodes[0].id;
    }

    return undefined;
  }

  private scopedCallOwner(symbolName: string): string | null {
    if (!symbolName.includes('::')) {
      return null;
    }
    const owner = symbolName.split('::')[0];
    if (!owner) {
      return null;
    }
    return this.getShortSymbolName(owner);
  }

  private compatibleSymbolNodes(nodes: WeaveNode[], sourceLanguage?: string): WeaveNode[] {
    if (!sourceLanguage) {
      return nodes;
    }
    return nodes.filter(node => this.languagesAreCompatible(sourceLanguage, node.language));
  }

  private languagesAreCompatible(source: string, target: string): boolean {
    if (source === target) {
      return true;
    }

    const frontend = new Set(['javascript', 'typescript', 'jsx', 'tsx', 'vue']);
    if (frontend.has(source) && frontend.has(target)) {
      return true;
    }

    return false;
  }

  /** Subgraph query: minimal connected context for a task. */
  query(query: SubgraphQuery): SubgraphResult {
    const specContext = query.options?.includeSpecContext === false
      ? null
      : this.specContextForFollowUp(query);
    const result = this.subgraph.extract(query);
    const querySpecContext = specContext
      ? this.buildQuerySpecContext(specContext, this.queryFileReference(query), query.task ?? query.scope ?? query.start)
      : undefined;
    if (result.nodes.length > 0 || result.edges.length > 0) {
      return {
        ...result,
        ...(querySpecContext ? { specContext: querySpecContext } : {}),
        resolution: { file: this.queryFileReference(query), status: 'ok', message: 'Query resolved to indexed graph nodes.' },
      };
    }

    return {
      ...result,
      ...(querySpecContext ? { specContext: querySpecContext } : {}),
      resolution: this.describeQueryResolution(query),
    };
  }

  /**
   * Context bundle: compact task context for an agent.
   * Returns a minimal working set, short mined constraints, and exemplar files.
   */
  context(query: ContextBundleQuery): ContextBundle {
    const specContext = this.specContextForFollowUp({
      start: query.start,
      scope: query.scope,
      fromSpec: query.fromSpec,
      fromSpecText: query.fromSpecText,
    });
    const taskProfile = (query.scope || specContext)
      ? this.buildTaskProfile(query.scope ?? query.start, specContext)
      : undefined;
    return this.buildContextBundle([query.start], query, taskProfile, {
      includeSpecContextEntries: false,
      includeSpecExistingStarts: false,
    });
  }

  /**
   * Agent bootstrap payload: Weave-first context plus compact operating rules.
   * Intended for wrappers/orchestrators that want to inject Weave invisibly.
   */
  bootstrap(query: BootstrapQuery): BootstrapPayload {
    const specInput = query.fromSpecText
      ?? query.fromSpec
      ?? this.inferSpecInputFromBootstrapQuery(query);
    let specContext = specInput ? this.buildSpecContext(specInput) : null;
    let taskProfile = this.buildTaskProfile(query.task, specContext);
    const entryCandidateLimit = query.maxEntryCandidates
      ?? (taskProfile.mode === 'audit_communication' ? 12 : 3);
    let entryCandidates = this.buildBootstrapEntryCandidates(query, taskProfile, entryCandidateLimit);
    const inferredSpecStart = !specContext && entryCandidates.find(candidate => this.isMarkdownSpecPath(candidate.file));
    if (inferredSpecStart) {
      specContext = this.buildSpecContext(inferredSpecStart.file);
      taskProfile = this.buildTaskProfile(query.task, specContext);
      entryCandidates = this.buildBootstrapEntryCandidates(query, taskProfile, entryCandidateLimit);
    }
    const defaultMaxFiles = specContext
      ? 16
      : taskProfile.mode === 'audit_communication'
        ? 12
        : taskProfile.mode === 'implementation' && taskProfile.focus === 'frontend'
          ? 5
          : 8;
    const start = entryCandidates[0]?.file;

    if (!start) {
      throw new Error('Unable to infer a starting file for this task.');
    }

    let context = this.buildContextBundle(
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
    context = this.withSpecPlannedFileExemplars(context, specContext, query.maxExemplars ?? 8);
    const scopeMismatch = this.detectScopeMismatch(taskProfile, context.workingSet);
    const guidance = [
      'Use the workingSet as the initial scope for this task.',
      'Treat workingSet items as explicit graph evidence and verify first-hop facts in code before editing.',
      'Treat constraints as advisory repo patterns, not hard rules.',
      'Treat exemplars as nearby examples to imitate when they fit, not as mandatory templates.',
      'Prefer reusing existing functions, actions, requests, components, and composables in the workingSet before inventing new structures.',
    ];
    if (this.hasWeakBootstrapEvidence(entryCandidates)) {
      guidance.push('No strong graph evidence matched the dominant task terms; treat inferred entries as weak fallback and prefer an explicit file or fromSpec input when available.');
    }
    if (scopeMismatch) {
      guidance.push(`Potential scope mismatch: ${scopeMismatch.reason}`);
    }
    if (taskProfile.mode === 'audit_communication') {
      guidance.push('This is a communication audit task, so the bundle intentionally includes reverse dependents, runtime communication surfaces, and infrastructure wiring.');
    }
    const fallbackPolicy = [
      'Widen search only if the workingSet is insufficient to complete the task.',
      'Widen search if explicit graph facts do not hold when inspected in code.',
      'If you widen search, do it narrowly and explain what was missing from the Weave bundle.',
    ];
    const warnings = this.buildBootstrapWarnings(taskProfile, context.workingSet);
    const compact = query.compact ?? Boolean(specContext);
    const payloadSpecContext = compact
      ? this.compactBootstrapSpecContext(specContext, query)
      : specContext;
    const payloadContext = compact
      ? this.compactBootstrapContext(context, specContext)
      : context;

    const payload: BootstrapPayload = {
      task: query.task,
      start,
      startSource: query.start ? 'provided' : 'inferred',
      taskMode: taskProfile.mode,
      spec: payloadSpecContext,
      scopeMismatch,
      warnings,
      entryCandidates,
      workingSet: payloadContext.workingSet,
      constraints: payloadContext.constraints,
      exemplars: payloadContext.exemplars,
      context: payloadContext,
      operatingMode: 'weave_first',
      guidance,
      fallbackPolicy,
      prompt: this.buildBootstrapPrompt(
        query.task,
        start,
        entryCandidates,
        payloadContext,
        guidance,
        fallbackPolicy,
        payloadSpecContext,
        compact,
      ),
    };

    if (compact) {
      // Keep payload.context available to in-process callers without paying for
      // a second serialized copy next to the top-level aliases.
      Object.defineProperty(payload, 'context', {
        value: payloadContext,
        enumerable: false,
        configurable: true,
      });
    }

    return payload;
  }

  /** Get derived conventions for a node kind. */
  conventions(kind?: string): Convention[] {
    return this.conventionEngine.getConventions(kind ? this.normalizeKindAlias(kind) : undefined)
      .filter(convention => convention.confidence >= 0.9);
  }

  /** Validate files against derived conventions. */
  validate(filePaths: string[]): ValidationViolation[] {
    return this.validator.validate(filePaths);
  }

  validateWithSummary(filePaths: string[] = [], options: ValidationOptions = {}): ValidationResult {
    const target = this.validationTargets(filePaths, options);
    const result = this.validator.validateWithSummary(target.files, target.source);
    const specContext = (options.includeSpecCoverage || options.fromSpecText || options.fromSpec) && (options.fromSpecText || options.fromSpec)
      ? this.buildSpecContext(options.fromSpecText ?? options.fromSpec as string)
      : null;
    const resultWithWorktree = target.worktree
      ? { ...result, worktree: target.worktree }
      : result;
    if (!specContext) {
      return resultWithWorktree;
    }
    return {
      ...resultWithWorktree,
      specCoverage: this.buildValidationSpecCoverage(target.files, specContext),
    };
  }

  /** Get the best exemplar for a node kind. */
  exemplar(kind: string, contextNodeId?: number, options: ExemplarOptions = {}): {
    nodeId: number;
    file: string;
    reason: string;
  } | null {
    const normalizedKind = this.normalizeKindAlias(kind);
    const filtered = this.getFilteredExemplar(normalizedKind, contextNodeId, options);
    if (filtered) {
      return filtered;
    }
    if (
      contextNodeId !== undefined
      && (normalizedKind === 'component' || normalizedKind === 'inertia_page')
    ) {
      return null;
    }
    return this.conventionEngine.getExemplar(normalizedKind, contextNodeId);
  }

  /** Blast radius: what would be affected by changing a symbol. */
  impact(fileOrSymbol: string, options: SubgraphQuery['options'] = {}): SubgraphResult {
    const impactOptions = this.withAutoImpactSummary(fileOrSymbol, options);
    const preSummary = impactOptions.summary === true && options.summary === undefined;
    let result = this.subgraph.impact(fileOrSymbol, impactOptions);
    if (preSummary) {
      result = this.markAutoSummarizedImpact(
        result,
        'Direct graph fanout exceeded the default full-impact threshold.',
      );
    } else if (this.shouldFailSoftToImpactSummary(result, options)) {
      result = this.markAutoSummarizedImpact(
        this.subgraph.impact(fileOrSymbol, { ...impactOptions, summary: true }),
        'Full impact result exceeded the default response budget; reran in summary mode.',
      );
    }
    const specContext = this.specContextForFollowUp({
      start: fileOrSymbol,
      task: impactOptions.task,
      scope: impactOptions.scope,
      fromSpec: impactOptions.fromSpec,
      fromSpecText: impactOptions.fromSpecText,
    });
    if (!specContext) {
      return result;
    }

    const querySpecContext = impactOptions.includeSpecContext === false
      ? undefined
      : this.buildQuerySpecContext(
          specContext,
          this.toRelativePath(fileOrSymbol),
          impactOptions.task ?? impactOptions.scope ?? fileOrSymbol,
        );
    return {
      ...result,
      impact: result.impact
        ? {
            ...result.impact,
            specTouchpoints: this.specTouchpointsForImpact(result.impact, specContext),
          }
        : result.impact,
      ...(querySpecContext ? { specContext: querySpecContext } : {}),
    };
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

  private queryFileReference(query: SubgraphQuery): string {
    const explicitLineMatch = query.start.match(/^(.+\.(?:php|vue|js|ts|tsx|jsx|py|md|css|scss|json|yaml|yml|sql)):\d+(?:-\d+)?$/);
    return this.toRelativePath(explicitLineMatch?.[1] ?? query.start);
  }

  private describeQueryResolution(query: SubgraphQuery): NonNullable<SubgraphResult['resolution']> {
    const file = this.queryFileReference(query);
    const content = this.readProjectTextFile(file);
    if (content === null) {
      return {
        file,
        status: 'missing_file',
        message: 'No indexed nodes were found because this file does not exist on disk. Treat it as a planned or stale spec reference before querying graph context.',
      };
    }

    return {
      file,
      status: 'not_indexed',
      message: 'The file exists on disk, but Weave did not index graph nodes for it. Check file type support, ignore rules, or rerun indexing after plugin changes.',
    };
  }

  private specContextForFollowUp(query: Pick<SubgraphQuery, 'start' | 'task' | 'scope' | 'fromSpec' | 'fromSpecText'>): BootstrapSpecContext | null {
    const specInput = query.fromSpecText
      ?? query.fromSpec
      ?? this.inferSpecInputFromFollowUpQuery(query);
    return specInput ? this.buildSpecContext(specInput) : null;
  }

  private withAutoImpactSummary(
    fileOrSymbol: string,
    options: SubgraphOptions,
  ): SubgraphOptions {
    if (
      options.summary !== undefined
      || options.maxTokens !== undefined
      || options.maxNodes !== undefined
      || options.maxEdges !== undefined
    ) {
      return options;
    }

    const explicitLineMatch = fileOrSymbol.match(/^(.+\.(?:php|vue|js|ts|tsx|jsx|py|md|css|scss|json|yaml|yml|sql)):\d+(?:-\d+)?$/);
    const file = this.toRelativePath(explicitLineMatch?.[1] ?? fileOrSymbol);
    const nodes = this.store.getNodesByFile(file);
    if (nodes.length === 0) {
      return options;
    }

    const edgeIds = new Set<number>();
    for (const node of nodes) {
      for (const edge of this.store.getEdgesFrom(node.id)) {
        edgeIds.add(edge.id);
      }
      for (const edge of this.store.getEdgesTo(node.id)) {
        edgeIds.add(edge.id);
      }
    }

    if (edgeIds.size < 50) {
      return options;
    }

    return {
      ...options,
      summary: true,
    };
  }

  private shouldFailSoftToImpactSummary(
    result: SubgraphResult,
    requestedOptions: SubgraphOptions,
  ): boolean {
    if (
      requestedOptions.summary !== undefined
      || requestedOptions.maxTokens !== undefined
      || requestedOptions.maxNodes !== undefined
      || requestedOptions.maxEdges !== undefined
      || !result.impact
    ) {
      return false;
    }

    const counts = result.impact.counts;
    const estimatedChars = JSON.stringify(result).length;
    return estimatedChars > 24_000
      || counts.crossFileNodes > 30
      || counts.crossFileEdges > 50
      || counts.intraFileEdges > 80;
  }

  private markAutoSummarizedImpact(result: SubgraphResult, reason: string): SubgraphResult {
    if (!result.impact) {
      return result;
    }

    return {
      ...result,
      impact: {
        ...result.impact,
        budget: {
          ...result.impact.budget,
          summary: true,
          autoSummarized: true,
          autoSummaryReason: reason,
          maxNodes: result.impact.budget?.maxNodes ?? result.nodes.length,
          maxEdges: result.impact.budget?.maxEdges ?? result.edges.length,
        },
      },
    };
  }

  private inferSpecInputFromFollowUpQuery(query: Pick<SubgraphQuery, 'start' | 'task' | 'scope'>): string | null {
    if (this.isMarkdownSpecPath(query.start) && this.readProjectTextFile(this.toRelativePath(query.start)) !== null) {
      return query.start;
    }

    const text = [query.task, query.scope, query.start].filter(Boolean).join(' ');
    return this.firstMentionedMarkdownSpecPath(text);
  }

  private buildQuerySpecContext(
    specContext: BootstrapSpecContext,
    startFile: string,
    queryText: string,
  ): QuerySpecContext {
    const terms = this.significantTaskTerms([
      ...this.extractTaskTerms(queryText),
      ...this.extractTaskTerms(startFile),
    ]);
    const lineFiles = new Set(specContext.lineReferences?.map(reference => reference.file) ?? []);
    const relatedExistingFiles = [...specContext.existingFiles]
      .map(file => {
        let score = 0;
        if (file === startFile) score += 100;
        if (lineFiles.has(file)) score += 40;
        score += this.sharedPathSegmentCount(
          this.pathSegmentsForSimilarity(startFile),
          this.pathSegmentsForSimilarity(file),
        ) * 8;
        score += this.fileTermMatchScore(file, terms) * 3;
        return { file, score };
      })
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, 12)
      .map(entry => entry.file);

    const relatedSet = new Set(relatedExistingFiles);
    const lineAnchoredQueries = (specContext.lineAnchoredQueries ?? [])
      .filter(query => relatedSet.has(query.file))
      .slice(0, 12);

    const relatedPlannedFiles = this.relatedPlannedFilesForQuery(
      specContext.plannedFiles ?? specContext.likelyNewFiles,
      startFile,
      terms,
    );
    const relatedPlannedSet = new Set(relatedPlannedFiles);

    return {
      file: specContext.file,
      digest: this.specContextDigest(specContext),
      mode: 'summary',
      note: 'Spec details are summarized for follow-up calls; use digest to correlate with the bootstrap response and call weave_bootstrap for full planned-file evidence.',
      relatedExistingFiles,
      lineAnchoredQueries,
      plannedFiles: relatedPlannedFiles,
      likelyNewFileExemplars: [],
      plannedFileExemplarRefs: (specContext.likelyNewFileExemplars ?? [])
        .filter(exemplar => relatedPlannedSet.has(exemplar.file))
        .slice(0, 16)
        .map(exemplar => ({
          file: exemplar.file,
          kind: exemplar.kind,
          exemplarFile: exemplar.exemplarFile,
          confidence: exemplar.confidence,
          coMentionConfidence: exemplar.coMentionConfidence,
          shapeMatchConfidence: exemplar.shapeMatchConfidence,
          confidenceReason: exemplar.confidenceReason,
        })),
      plannedFilePatternRefs: (specContext.plannedFilePatterns ?? [])
        .filter(pattern => relatedPlannedSet.has(pattern.file))
        .slice(0, 8)
        .map(pattern => ({
          file: pattern.file,
          kind: pattern.kind,
          role: pattern.role,
          status: pattern.status,
          directExemplarFile: pattern.directExemplarFile,
          confidence: pattern.confidence,
      })),
    };
  }

  private specTouchpointsForImpact(
    impact: NonNullable<SubgraphResult['impact']>,
    specContext: BootstrapSpecContext,
  ): NonNullable<NonNullable<SubgraphResult['impact']>['specTouchpoints']> {
    const targetFiles = new Set(impact.targetFiles);
    const impactedFiles = new Set([
      ...impact.targetFiles,
      ...impact.crossFileNodes.map(node => node.file),
    ]);
    const seen = new Set<string>();
    const touchpoints: NonNullable<NonNullable<SubgraphResult['impact']>['specTouchpoints']> = [];

    for (const reference of specContext.lineReferences ?? []) {
      const key = `${reference.file}:${reference.lineStart}:${reference.lineEnd ?? reference.lineStart}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const status = targetFiles.has(reference.file)
        ? 'target'
        : impactedFiles.has(reference.file)
          ? 'impacted'
          : 'spec_related_not_impacted';
      touchpoints.push({
        file: reference.file,
        status,
        reason: status === 'target'
          ? 'Spec line anchor is inside the impact target.'
          : status === 'impacted'
            ? 'Spec line anchor is also connected by current graph impact edges.'
            : 'Spec line anchor is related by the spec but has no current graph impact edge from this target.',
        lineStart: reference.lineStart,
        ...(reference.lineEnd ? { lineEnd: reference.lineEnd } : {}),
      });
    }

    return touchpoints.slice(0, 16);
  }

  private buildValidationSpecCoverage(
    filePaths: string[],
    specContext: BootstrapSpecContext,
  ): NonNullable<ValidationResult['specCoverage']> {
    const checkedFiles = Array.from(new Set(filePaths.map(file => this.toRelativePath(file)))).sort();
    const checkedSet = new Set(checkedFiles);
    const expectedFiles = Array.from(new Set([
      ...specContext.existingFiles,
      ...(specContext.plannedFiles ?? specContext.likelyNewFiles),
    ])).sort();
    const checkedExpectedFiles = expectedFiles.filter(file => checkedSet.has(file));
    const uncheckedExpectedFiles = expectedFiles.filter(file => !checkedSet.has(file));
    const missingExpectedFiles = expectedFiles.filter(file => !existsSync(join(this.projectRoot, file)));
    const missingUnchecked = missingExpectedFiles.filter(file => !checkedSet.has(file));
    const message = uncheckedExpectedFiles.length === 0 && missingExpectedFiles.length === 0
      ? `Validated all ${expectedFiles.length} spec-referenced files.`
      : `Validated ${checkedExpectedFiles.length}/${expectedFiles.length} spec-referenced files; ${uncheckedExpectedFiles.length} unchecked, ${missingExpectedFiles.length} missing on disk.`
        + (missingUnchecked.length > 0 ? ' Create missing planned files before treating validation as complete.' : '');

    return {
      file: specContext.file,
      checkedFiles,
      expectedFiles,
      checkedExpectedFiles,
      uncheckedExpectedFiles,
      missingExpectedFiles,
      message,
    };
  }

  private validationTargets(
    filePaths: string[],
    options: ValidationOptions,
  ): {
    files: string[];
    source: NonNullable<ValidationSummary['source']>;
    worktree?: NonNullable<ValidationResult['worktree']>;
  } {
    if (!options.changedOnly && !options.stagedOnly && filePaths.length > 0) {
      const files = Array.from(new Set(filePaths.map(file => this.toRelativePath(file)))).sort();
      return { files, source: 'explicit_files' };
    }

    const worktree = options.stagedOnly
      ? this.gitStagedValidationTargets()
      : this.gitUncommittedValidationTargets();
    return {
      files: worktree.checkedFiles,
      source: worktree.source,
      worktree,
    };
  }

  private gitStagedValidationTargets(): NonNullable<ValidationResult['worktree']> {
    let output = '';
    try {
      output = execFileSync('git', [
        'diff',
        '--cached',
        '--name-status',
        '--diff-filter=ACMRD',
      ], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return {
        source: 'git_staged',
        checkedFiles: [],
        changedFiles: [],
        deletedFiles: [],
        unavailableReason: 'git diff --cached failed; project may not be a git worktree',
        message: 'No files validated because staged git changes were unavailable. Pass files explicitly to validate codebase patterns without git worktree detection.',
      };
    }

    return this.gitValidationTargetsFromNameStatus(output, 'git_staged', {
      changedMessage: count => `Validating ${count} staged git file(s) against mined codebase patterns.`,
      emptyMessage: 'No staged git files found to validate. Pass files explicitly or omit stagedOnly to validate uncommitted files.',
    });
  }

  private gitUncommittedValidationTargets(): NonNullable<ValidationResult['worktree']> {
    let output = '';
    try {
      output = execFileSync('git', [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return {
        source: 'git_uncommitted',
        checkedFiles: [],
        changedFiles: [],
        deletedFiles: [],
        unavailableReason: 'git status failed; project may not be a git worktree',
        message: 'No files validated because git status was unavailable. Pass files explicitly to validate codebase patterns without git worktree detection.',
      };
    }

    return this.gitValidationTargetsFromPorcelain(output);
  }

  private gitValidationTargetsFromPorcelain(output: string): NonNullable<ValidationResult['worktree']> {
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];
    for (const rawLine of output.split('\n')) {
      if (!rawLine.trim()) {
        continue;
      }
      const status = rawLine.slice(0, 2);
      let file = rawLine.slice(3).trim();
      if (file.includes(' -> ')) {
        file = file.split(' -> ').pop() ?? file;
      }
      file = this.toRelativePath(file.replace(/^"|"$/g, ''));
      if (!file || this.isGeneratedPath(file)) {
        continue;
      }
      if (status.includes('D') && !existsSync(join(this.projectRoot, file))) {
        deletedFiles.push(file);
      } else {
        changedFiles.push(file);
      }
    }

    const checkedFiles = Array.from(new Set(changedFiles))
      .filter(file => existsSync(join(this.projectRoot, file)))
      .sort();
    const uniqueChangedFiles = Array.from(new Set(changedFiles)).sort();
    const uniqueDeletedFiles = Array.from(new Set(deletedFiles)).sort();
    return {
      source: 'git_uncommitted',
      checkedFiles,
      changedFiles: uniqueChangedFiles,
      deletedFiles: uniqueDeletedFiles,
      message: checkedFiles.length > 0
        ? `Validating ${checkedFiles.length} uncommitted git file(s) against mined codebase patterns.`
        : 'No uncommitted git files found to validate. Pass files explicitly to validate a specific change set.',
    };
  }

  private gitValidationTargetsFromNameStatus(
    output: string,
    source: 'git_staged',
    messages: {
      changedMessage: (count: number) => string;
      emptyMessage: string;
    },
  ): NonNullable<ValidationResult['worktree']> {
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];
    for (const rawLine of output.split('\n')) {
      if (!rawLine.trim()) {
        continue;
      }
      const [status, ...pathParts] = rawLine.split('\t');
      let file = pathParts[pathParts.length - 1] ?? '';
      file = this.toRelativePath(file.replace(/^"|"$/g, ''));
      if (!file || this.isGeneratedPath(file)) {
        continue;
      }
      if (status.includes('D') && !existsSync(join(this.projectRoot, file))) {
        deletedFiles.push(file);
      } else {
        changedFiles.push(file);
      }
    }

    const checkedFiles = Array.from(new Set(changedFiles))
      .filter(file => existsSync(join(this.projectRoot, file)))
      .sort();
    const uniqueChangedFiles = Array.from(new Set(changedFiles)).sort();
    const uniqueDeletedFiles = Array.from(new Set(deletedFiles)).sort();
    return {
      source,
      checkedFiles,
      changedFiles: uniqueChangedFiles,
      deletedFiles: uniqueDeletedFiles,
      message: checkedFiles.length > 0
        ? messages.changedMessage(checkedFiles.length)
        : messages.emptyMessage,
    };
  }

  private specContextDigest(specContext: BootstrapSpecContext): string {
    return createHash('sha256')
      .update(JSON.stringify({
        file: specContext.file,
        referencedFiles: specContext.referencedFiles,
        plannedFiles: specContext.plannedFiles,
        existingFiles: specContext.existingFiles,
      }))
      .digest('hex')
      .slice(0, 12);
  }

  private relatedPlannedFilesForQuery(
    plannedFiles: string[],
    startFile: string,
    terms: string[],
  ): string[] {
    const startKind = this.primaryKindForFile(startFile);
    const startSegments = this.pathSegmentsForSimilarity(startFile);
    return plannedFiles
      .map(file => {
        const kind = this.inferKindForPath(file);
        let score = this.sharedPathSegmentCount(
          startSegments,
          this.pathSegmentsForSimilarity(file),
        ) * 10;
        score += this.fileTermMatchScore(file, terms) * 3;
        if (kind && this.normalizeKindAlias(kind) === this.normalizeKindAlias(startKind)) {
          score += 30;
        }
        return { file, score };
      })
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, 6)
      .map(entry => entry.file);
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
    const plugins = await this.pluginLoader.detectAndLoad();
    const currentFingerprint = this.computeIndexerFingerprint(plugins);

    if (!existsSync(this.graphPath) || !hasGraphData) {
      await this.init();
      return { initialized: true, updatedFiles: 0 };
    }

    if (!this.isStoredIndexerFingerprintCurrent(currentFingerprint)) {
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

  private getDiagnosticsSnapshot(): IndexingDiagnostics {
    const current = this.diagnostics.snapshot();
    const hasCurrentData =
      current.files.length > 0
      || current.pluginRules.length > 0
      || current.issues.length > 0;

    if (hasCurrentData) {
      return this.filterDiagnosticsSnapshot(current);
    }

    if (!existsSync(this.diagnosticsPath)) {
      return this.filterDiagnosticsSnapshot(current);
    }

    try {
      return this.filterDiagnosticsSnapshot(JSON.parse(readFileSync(this.diagnosticsPath, 'utf-8')));
    } catch {
      return this.filterDiagnosticsSnapshot(current);
    }
  }

  private filterDiagnosticsSnapshot(snapshot: IndexingDiagnostics): IndexingDiagnostics {
    const files = snapshot.files.filter(file => !this.isGeneratedPath(file.file));
    const issues = snapshot.issues.filter(issue => !this.isGeneratedPath(issue.file));

    return {
      ...snapshot,
      files,
      issues,
      totals: {
        l2EdgesCreated: files.reduce((sum, file) => sum + file.l2EdgesCreated, 0),
        l2EdgesSkipped: files.reduce((sum, file) => sum + file.l2EdgesSkipped, 0),
        l3EdgesCreated: files.reduce((sum, file) => sum + file.l3EdgesCreated, 0),
        l3EdgesSkipped: files.reduce((sum, file) => sum + file.l3EdgesSkipped, 0),
        nodeCreates: files.reduce((sum, file) => sum + file.nodeCreates, 0),
        metadataUpdates: files.reduce((sum, file) => sum + file.metadataUpdates, 0),
        queryErrors: files.reduce((sum, file) => sum + file.queryErrors, 0),
        issues: issues.length,
        externalIssues: issues.filter(issue => issue.classification === 'external_dependency').length,
        internalIssues: issues.filter(issue => issue.classification === 'internal_unresolved').length,
        unknownIssues: issues.filter(issue => !issue.classification || issue.classification === 'unknown').length,
      },
    };
  }

  private persistDiagnostics(): void {
    writeFileSync(this.diagnosticsPath, JSON.stringify(this.diagnostics.snapshot(), null, 2));
  }

  private computeIndexerFingerprint(plugins: ConventionPlugin[]): IndexerFingerprint {
    const hash = createHash('sha256');
    hash.update(JSON.stringify({
      version: INDEXER_FINGERPRINT_VERSION,
      config: {
        monorepo: this.config.monorepo,
        conventionOverrides: this.config.conventionOverrides,
        plugins: this.config.plugins,
      },
    }));

    for (const file of this.indexerRuntimeFiles()) {
      hash.update(file);
      hash.update(readFileSync(file));
    }

    const pluginPayload = plugins
      .map(plugin => ({
        name: plugin.name,
        version: plugin.version,
        detect: plugin.detect,
        nodeKinds: plugin.nodeKinds ?? [],
        rules: plugin.rules,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    hash.update(JSON.stringify(pluginPayload));

    return {
      version: INDEXER_FINGERPRINT_VERSION,
      hash: hash.digest('hex'),
      plugins: pluginPayload.map(plugin => `${plugin.name}@${plugin.version}`),
      generatedAt: new Date().toISOString(),
    };
  }

  private indexerRuntimeFiles(): string[] {
    const modulePath = fileURLToPath(import.meta.url);
    const moduleDir = dirname(modulePath);
    const extension = extname(modulePath);
    return [
      join(moduleDir, `weave${extension}`),
      join(moduleDir, 'parser', `symbols${extension}`),
      join(moduleDir, 'plugins', `runner${extension}`),
      join(moduleDir, 'plugins', `loader${extension}`),
      join(moduleDir, 'conventions', `engine${extension}`),
      join(moduleDir, 'conventions', `validator${extension}`),
      join(moduleDir, 'graph', `subgraph${extension}`),
      join(moduleDir, 'cache', `watcher${extension}`),
    ].filter(file => existsSync(file));
  }

  private persistIndexerFingerprint(fingerprint: IndexerFingerprint): void {
    writeFileSync(this.fingerprintPath, `${JSON.stringify(fingerprint, null, 2)}\n`);
  }

  private isStoredIndexerFingerprintCurrent(current: IndexerFingerprint): boolean {
    if (!existsSync(this.fingerprintPath)) {
      return false;
    }

    try {
      const stored = JSON.parse(readFileSync(this.fingerprintPath, 'utf-8')) as Partial<IndexerFingerprint>;
      return stored.version === current.version && stored.hash === current.hash;
    } catch {
      return false;
    }
  }

  private buildContextBundle(
    starts: string[],
    query: ContextBundleQuery,
    taskProfile?: TaskProfile,
    options: {
      includeSpecContextEntries?: boolean;
      includeSpecExistingStarts?: boolean;
    } = {
      includeSpecContextEntries: true,
      includeSpecExistingStarts: true,
    },
  ): ContextBundle {
    const normalizedStarts = starts.map(start => this.toRelativePath(start));
    const result = this.extractCombinedSubgraph(normalizedStarts, query, taskProfile, options);
    const workingSet = this.buildWorkingSet(result, normalizedStarts, query, taskProfile, options);

    return {
      workingSet,
      constraints: this.buildContextConstraints(result, query, taskProfile, workingSet),
      exemplars: this.buildContextExemplars(result, workingSet.map(file => file.file), query, taskProfile),
    };
  }

  private extractCombinedSubgraph(
    starts: string[],
    query: Pick<ContextBundleQuery, 'scope' | 'depth'>,
    taskProfile?: TaskProfile,
    options: { includeSpecExistingStarts?: boolean } = { includeSpecExistingStarts: true },
  ): SubgraphResult {
    const nodeMap = new Map<number, SubgraphNode>();
    const edgeMap = new Map<string, SubgraphEdge>();
    const traversalStarts = taskProfile?.specContext && options.includeSpecExistingStarts !== false
      ? Array.from(new Set([...starts, ...taskProfile.specContext.existingFiles]))
      : starts;

    for (const start of traversalStarts) {
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

      if (
        taskProfile?.mode === 'audit_communication'
        || taskProfile?.mode === 'audit_architecture'
        || taskProfile?.specContext?.existingFiles.includes(start)
      ) {
        results.push(this.subgraph.impact(start, { summary: true, maxNodes: 32, maxEdges: 48 }));
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
    options: { includeSpecContextEntries?: boolean } = { includeSpecContextEntries: true },
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
      provenance: ContextProvenance;
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
      if (options.includeSpecContextEntries !== false) {
        this.addSpecContextFiles(fileEntries, taskProfile);
      }
      this.addEndpointLiteralContextFiles(fileEntries, taskProfile);
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
      }) => {
        const reasons = Array.from(entry.reasons.values());
        return startSet.has(entry.file)
        || this.isSpecContextEntry(entry.reasons)
        || entry.reasons.has('primary entry candidate')
        || entry.reasons.has('entry candidate')
        || this.fileTermMatchScore(entry.file, significantTerms) > 0
        || reasons.some(reason =>
          reason.text.includes('renders_child')
          || reason.text.includes('uses_composable')
          || reason.text.startsWith('imported by ')
          || reason.text.includes('endpoint')
          || reason.text.includes('HTTP client')
          || reason.text.includes('route table'),
        );
      };

      const lowValueFiltered = rankedEntries.filter(entry =>
        !this.isLowValuePrecedent(entry.file, taskProfile.terms)
        || startSet.has(entry.file)
        || this.isSpecContextEntry(entry.reasons)
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
        || this.isSpecContextEntry(entry.reasons)
        || entry.reasons.has('primary entry candidate')
        || entry.reasons.has('entry candidate')
        || Array.from(entry.reasons.values()).some(reason =>
          reason.text.includes('endpoint')
          || reason.text.includes('HTTP client')
          || reason.text.includes('route table'),
        )
        || entry.score >= scoreFloor,
      );
      if (filteredEntries.length >= Math.min(maxFiles, 4)) {
        rankedEntries = filteredEntries;
      }
    }

    return rankedEntries
      .slice(0, maxFiles)
      .map(entry => {
        const isPrimaryStart = primaryStart !== null && entry.file === primaryStart;
        return {
          file: entry.file,
          kind: this.primaryContextKind(entry.file, entry.kinds),
          kinds: Array.from(entry.kinds).sort(),
          provenance: entry.provenance,
          confidence: this.fileEntryConfidence(entry, isPrimaryStart),
          reasons: this.fileEntryReasons(entry, isPrimaryStart),
          anchors: entry.anchors
            .sort((a, b) => this.anchorPriority(b) - this.anchorPriority(a) || a.lines[0] - b.lines[0])
            .slice(0, 3)
            .map(node => ({
              symbol: node.symbol,
              kind: node.kind,
              lines: node.lines,
            })),
        };
      });
  }

  private isSpecContextEntry(reasons: Map<string, ContextReason>): boolean {
    return reasons.has('provided spec document')
      || Array.from(reasons.keys()).some(reason => reason.startsWith('listed in spec '));
  }

  private primaryContextKind(filePath: string, kinds: Iterable<string>): string | null {
    const ranked = Array.from(kinds)
      .filter(kind => kind !== 'file')
      .sort((a, b) => this.bundleKindPriority(b) - this.bundleKindPriority(a));

    return ranked[0] ?? this.inferKindForPath(filePath);
  }

  private buildContextConstraints(
    result: SubgraphResult,
    query: ContextBundleQuery,
    taskProfile?: TaskProfile,
    workingSet: ContextFile[] = [],
  ): ContextConstraint[] {
    const maxConstraints = query.maxConstraints ?? 6;
    const workingKinds = this.getPreferredContextKinds(result, taskProfile, workingSet);

    const constraints: ContextConstraint[] = [];
    for (const kind of workingKinds) {
      const conventions = this.conventionEngine.getConventions(kind)
        .filter(convention => convention.confidence >= 0.9)
        .sort((a, b) => b.confidence - a.confidence || b.frequency - a.frequency)
        .slice(0, 3);

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
          plugin: this.pluginForConventionKind(kind),
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

  private withSpecPlannedFileExemplars(
    context: ContextBundle,
    specContext: BootstrapSpecContext | null,
    maxExemplars: number,
  ): ContextBundle {
    const specExemplars = this.specPlannedFileContextExemplars(specContext, maxExemplars);
    if (specExemplars.length === 0) {
      return context;
    }

    const deduped = new Map<string, ContextExemplar>();
    for (const exemplar of [...specExemplars, ...context.exemplars]) {
      const key = `${exemplar.plannedFile ?? exemplar.kind}:${exemplar.file}`;
      if (!deduped.has(key)) {
        deduped.set(key, exemplar);
      }
    }

    return {
      ...context,
      exemplars: Array.from(deduped.values()).slice(0, maxExemplars),
    };
  }

  private specPlannedFileContextExemplars(
    specContext: BootstrapSpecContext | null,
    maxExemplars: number,
  ): ContextExemplar[] {
    if (!specContext) {
      return [];
    }

    const plannedExemplars = (specContext.likelyNewFileExemplars ?? [])
      .filter(exemplar => exemplar.exemplarFile !== null)
      .map(exemplar => ({
        kind: exemplar.kind ?? 'unknown',
        file: exemplar.exemplarFile as string,
        plannedFile: exemplar.file,
        reason: `planned file ${exemplar.file}: ${exemplar.reason}`,
        provenance: 'spec_planned_file' as const,
        confidence: exemplar.confidence,
        coMentionConfidence: exemplar.coMentionConfidence,
        shapeMatchConfidence: exemplar.shapeMatchConfidence,
        nodeId: exemplar.exemplarNodeId ?? 0,
      }));

    const testExemplar = this.specImpliedTestContextExemplar(specContext, plannedExemplars);
    return [
      ...plannedExemplars,
      ...(testExemplar ? [testExemplar] : []),
    ].slice(0, maxExemplars);
  }

  private specImpliedTestContextExemplar(
    specContext: BootstrapSpecContext,
    existingExemplars: ContextExemplar[],
  ): ContextExemplar | null {
    if (!this.specContextMentionsTests(specContext)) {
      return null;
    }
    if (existingExemplars.some(exemplar => this.normalizeKindAlias(exemplar.kind) === 'test')) {
      return null;
    }

    const exemplar = this.exemplar('test');
    if (!exemplar) {
      return null;
    }

    return {
      kind: 'test',
      file: exemplar.file,
      reason: `Spec mentions tests; use this existing test as a pattern. ${exemplar.reason}`,
      provenance: 'structural_similarity',
      confidence: Math.min(0.8, this.kindConventionConfidence('test')),
      nodeId: exemplar.nodeId,
    };
  }

  private specContextMentionsTests(specContext: BootstrapSpecContext): boolean {
    if (specContext.mentionsTests) {
      return true;
    }
    const terms = new Set([
      ...(specContext.termIndex ?? []),
      ...(specContext.terms ?? []),
    ].map(term => term.toLowerCase()));
    return ['test', 'tests', 'testing', 'spec', 'specs', 'phpunit', 'pest', 'coverage', 'assert']
      .some(term => terms.has(term));
  }

  private specTextMentionsTests(content: string): boolean {
    return /\b(?:tests?|testing|specs?|phpunit|pest|coverage|assert(?:ion|ions)?)\b/i.test(content);
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
    const candidateScores = new Map<string, number>();

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
          if (!workingFiles.has(source.filePath) && !this.isLowValuePrecedent(source.filePath, taskProfile.terms)) {
            const current = candidateScores.get(source.filePath) ?? 0;
            const relationshipBonus = edge.relationship === 'renders_child' ? 22 : 12;
            candidateScores.set(source.filePath, current + relationshipBonus + this.bundleKindPriority(source.kind) * 0.05);
          }
        }
      }
    }

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
      provenance: ContextProvenance;
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

  private fileEntryReasons(
    entry: {
      file: string;
      reasons: Map<string, ContextReason>;
      provenance: ContextProvenance;
    },
    isPrimaryStart: boolean,
  ): ContextReason[] {
    const reasons = this.sortReasons(entry.reasons);
    if (reasons.length > 0) {
      return reasons;
    }

    return [{
      text: isPrimaryStart
        ? 'primary entry candidate'
        : entry.provenance === 'explicit_graph'
          ? 'included by graph traversal'
          : 'included by task heuristic score',
      provenance: entry.provenance,
      confidence: isPrimaryStart ? 1 : entry.provenance === 'explicit_graph' ? 0.75 : 0.72,
    }];
  }

  private getPreferredContextKinds(
    result: SubgraphResult,
    taskProfile?: TaskProfile,
    workingSet: ContextFile[] = [],
  ): string[] {
    const availableKinds = new Set(
      result.nodes
        .filter(node => !this.isGeneratedPath(node.file))
        .map(node => node.kind)
        .filter(kind => kind !== 'file'),
    );
    for (const file of workingSet) {
      for (const kind of file.kinds) {
        if (kind !== 'file' && kind !== 'spec') {
          availableKinds.add(this.normalizeKindAlias(kind));
        }
      }
      const inferredKind = this.inferKindForPath(file.file);
      if (inferredKind && inferredKind !== 'file' && inferredKind !== 'spec') {
        availableKinds.add(inferredKind);
      }
    }
    if (taskProfile?.specContext) {
      for (const file of taskProfile.specContext.likelyNewFiles) {
        const inferredKind = this.inferKindForPath(file);
        if (inferredKind && inferredKind !== 'file' && inferredKind !== 'spec') {
          availableKinds.add(inferredKind);
        }
      }
    }

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
    if (node.kind === 'model') return 84;
    if (node.kind === 'migration') return 83;
    if (node.kind === 'form_request') return 82;
    if (node.kind === 'service') return 81;
    if (node.kind === 'config_array') return 79;
    if (node.kind === 'method') return 80;
    if (node.kind === 'class') return 70;
    if (node.kind === 'function') return 60;
    if (node.kind === 'spec') return 58;
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

  private getFilteredExemplar(
    kind: string,
    contextNodeId: number | undefined,
    options: ExemplarOptions,
  ): { nodeId: number; file: string; reason: string } | null {
    if (kind === 'action' && (options.routeMethod || options.subKind)) {
      return this.getActionExemplarForRouteShape(options);
    }

    if (kind === 'component' && options.subKind) {
      return this.getComponentExemplarForShape(options.subKind);
    }

    if (kind === 'inertia_page' && options.subKind) {
      return this.getInertiaPageExemplarForShape(options.subKind);
    }

    if ((kind === 'component' || kind === 'inertia_page') && contextNodeId !== undefined) {
      return this.getContextualExemplar(kind, contextNodeId, options);
    }

    if (kind === 'service') {
      return this.getServiceExemplarFallback();
    }

    return null;
  }

  private getServiceExemplarFallback(): { nodeId: number; file: string; reason: string } | null {
    const scored = this.store.getNodesByKind('service')
      .filter(node => !this.isGeneratedPath(node.filePath))
      .map(node => {
        const source = this.readProjectTextFile(node.filePath) ?? '';
        let score = 10;
        if (/^(?:app|src)\/Services\//i.test(node.filePath)) score += 24;
        if (/^(?:app|src)\/Clients\//i.test(node.filePath)) score += 12;
        if (/\b(config|Cache::|Storage::|Http::|fetch|axios|validate|resolve|registry|lookup)\b/i.test(source)) score += 8;
        if ((node.lineEnd - node.lineStart) <= 220) score += 4;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    const best = scored[0];
    if (!best) {
      return null;
    }
    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: 'Best indexed service-shaped exemplar; verify role fit before copying because service conventions may be sparse.',
    };
  }

  private getInertiaPageExemplarForShape(
    subKind: string,
  ): { nodeId: number; file: string; reason: string } | null {
    const normalizedSubKind = subKind.toLowerCase();
    const scored = this.store.getNodesByKind('inertia_page')
      .filter(node => !this.isGeneratedPath(node.filePath))
      .map(node => ({
        node,
        score: this.inertiaPageShapeScore(node, normalizedSubKind),
      }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    const best = scored[0];
    if (!best) {
      return null;
    }

    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: `Best ${subKind} inertia_page exemplar by page path and source shape`,
    };
  }

  private inertiaPageShapeScore(node: WeaveNode, subKind: string): number {
    const file = node.filePath;
    const identifier = `${node.symbolName} ${file}`;
    const source = this.readProjectTextFile(file) ?? '';
    let score = 0;

    if (this.identifierContainsSubKind(identifier, subKind)) {
      score += 40;
    }

    if (subKind === 'index' || subKind === 'list') {
      if (/\/(?:Index|List)\.vue$/i.test(file)) score += 34;
      if (/\bv-for\b|<table\b|\bitems\b|\brows\b|\bfilters\b/i.test(source)) score += 18;
      if (/\/(?:Show|Create|Edit)\.vue$/i.test(file)) score -= 28;
    } else if (subKind === 'show' || subKind === 'detail') {
      if (/\/Show\.vue$/i.test(file)) score += 34;
      if (/\bdefineProps\b|<section\b|<article\b/i.test(source)) score += 10;
      if (/\/(?:Index|List|Create|Edit)\.vue$/i.test(file)) score -= 20;
    } else if (subKind === 'create' || subKind === 'edit' || subKind === 'form') {
      if (/\/(?:Create|Edit|Form)\.vue$/i.test(file)) score += 34;
      if (/\buseForm\b|<form\b|router\.(?:post|put|patch)\b/i.test(source)) score += 24;
      if (/\/(?:Index|List|Show)\.vue$/i.test(file)) score -= 20;
    }

    return score;
  }

  private getContextualExemplar(
    kind: string,
    contextNodeId: number,
    options: ExemplarOptions,
  ): { nodeId: number; file: string; reason: string } | null {
    const contextNode = this.store.getNodeById(contextNodeId);
    if (!contextNode) {
      return null;
    }

    const candidates = new Map<number, number>();
    const addCandidate = (node: WeaveNode, relationship: string, direction: 'incoming' | 'outgoing') => {
      if (node.filePath === contextNode.filePath || this.isGeneratedPath(node.filePath)) {
        return;
      }

      const candidateKind = this.normalizeKindAlias(node.kind);
      if (candidateKind !== kind && !(kind === 'component' && candidateKind === 'inertia_page')) {
        return;
      }

      const source = this.readProjectTextFile(node.filePath) ?? '';
      const identifier = `${node.symbolName} ${node.filePath}`;
      const wantsLayout = options.subKind !== undefined
        && ['layout', 'shell'].includes(options.subKind.toLowerCase());
      if (!wantsLayout && /layout|shell/i.test(identifier) && source.includes('<slot')) {
        return;
      }

      let score = candidates.get(node.id) ?? 0;
      score += direction === 'outgoing' ? 34 : 24;
      if (relationship === 'renders_child') score += 24;
      else if (relationship === 'imports') score += 12;
      else if (relationship === 'uses_composable') score += 8;
      if (options.subKind && candidateKind === 'component') {
        score += this.componentShapeScore(node, options.subKind.toLowerCase());
      }
      score += this.sharedPathSegmentCount(
        this.pathSegmentsForSimilarity(contextNode.filePath),
        this.pathSegmentsForSimilarity(node.filePath),
      ) * 4;
      candidates.set(node.id, score);
    };

    for (const edge of this.store.getEdgesFrom(contextNodeId)) {
      if (!['renders_child', 'imports', 'uses_composable'].includes(edge.relationship)) {
        continue;
      }
      const target = this.store.getNodeById(edge.targetId);
      if (target) {
        addCandidate(target, edge.relationship, 'outgoing');
      }
    }

    for (const edge of this.store.getEdgesTo(contextNodeId)) {
      if (!['renders_child', 'imports', 'uses_composable'].includes(edge.relationship)) {
        continue;
      }
      const source = this.store.getNodeById(edge.sourceId);
      if (source) {
        addCandidate(source, edge.relationship, 'incoming');
      }
    }

    const best = Array.from(candidates.entries())
      .map(([nodeId, score]) => ({ node: this.store.getNodeById(nodeId), score }))
      .filter((candidate): candidate is { node: WeaveNode; score: number } => Boolean(candidate.node))
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath))[0];

    if (!best) {
      return null;
    }

    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: `Best ${kind} exemplar connected to ${contextNode.filePath}`,
    };
  }

  private getComponentExemplarForShape(
    subKind: string,
  ): { nodeId: number; file: string; reason: string } | null {
    const normalizedSubKind = subKind.toLowerCase();
    const scored = this.store.getNodesByKind('component')
      .filter(node => !this.isGeneratedPath(node.filePath))
      .map(node => ({
        node,
        score: this.componentShapeScore(node, normalizedSubKind),
      }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    const best = scored[0];
    if (!best) {
      return null;
    }

    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: `Best ${subKind} component exemplar by path and component shape`,
    };
  }

  private componentShapeScore(node: WeaveNode, subKind: string): number {
    const file = node.filePath;
    const identifier = `${node.symbolName} ${file}`;
    const source = this.readProjectTextFile(file) ?? '';
    let score = 0;

    if (this.identifierContainsSubKind(identifier, subKind)) {
      score += 40;
    }

    if (subKind === 'leaf') {
      if (file.startsWith('resources/js/Components/')) score += 24;
      if (file.startsWith('resources/js/Pages/')) score -= 30;
      if (/layout|shell|page/i.test(identifier)) score -= 24;
      if (/modal|dialog/i.test(identifier)) score -= 28;
      if (!source.includes('<slot')) score += 10;
      if ((node.lineEnd - node.lineStart) <= 180) score += 8;
    } else if (subKind === 'modal' || subKind === 'dialog') {
      if (/modal|dialog/i.test(identifier)) score += 24;
      if (source.includes('<Modal') || source.includes("from '@/Components/Modal") || source.includes('from "@/Components/Modal')) {
        score += 24;
      }
    } else if (subKind === 'layout' || subKind === 'shell') {
      if (/layout|shell/i.test(identifier)) score += 30;
      if (source.includes('<slot')) score += 14;
    } else if (subKind === 'form') {
      if (/form/i.test(identifier)) score += 20;
      if (source.includes('useForm') || /<form\b/i.test(source)) score += 20;
    } else if (subKind === 'table' || subKind === 'list') {
      if (/table|list|index/i.test(identifier)) score += 18;
      if (/<table\b|v-for=/i.test(source)) score += 18;
    }

    return score;
  }

  private getActionExemplarForRouteShape(
    options: ExemplarOptions,
  ): { nodeId: number; file: string; reason: string } | null {
    const requestedMethods = new Set(
      [
        ...(options.routeMethod ? [options.routeMethod] : []),
        ...this.routeMethodsForSubKind(options.subKind),
      ]
        .map(method => method.toUpperCase())
        .filter(Boolean),
    );
    const subKind = options.subKind?.toLowerCase() ?? '';
    const candidates = this.store.getNodesByKind('action')
      .filter(node => !this.isGeneratedPath(node.filePath));

    const scored = candidates.map(node => {
      const routeEdges = this.routeEdgesForFile(node.filePath);
      let score = this.kindConventionConfidence('action') * 10;

      for (const edge of routeEdges) {
        const method = String(edge.metadata?.method ?? '').toUpperCase();
        if (requestedMethods.size > 0 && requestedMethods.has(method)) {
          score += 40;
        }
        if (requestedMethods.size > 0 && requestedMethods.has('MUTATION') && method && method !== 'GET') {
          score += 32;
        }
        if (method === 'GET' && this.subKindLooksReadOnly(subKind)) {
          score += 24;
        }
        if (method && method !== 'GET' && this.subKindLooksMutating(subKind)) {
          score += 24;
        }
      }

      score += this.actionShapeScore(node, options, routeEdges);

      return { node, score, routeEdges };
    })
      .filter(candidate => candidate.score > this.kindConventionConfidence('action') * 10)
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    const best = scored[0];
    if (!best) {
      return null;
    }

    const methods = Array.from(new Set(
      best.routeEdges
        .map(edge => String(edge.metadata?.method ?? '').toUpperCase())
        .filter(Boolean),
    )).join(', ');

    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: `Best ${options.subKind ?? options.routeMethod ?? 'route-shaped'} action exemplar${methods ? ` (${methods})` : ''}`,
    };
  }

  private actionShapeScore(
    node: WeaveNode,
    options: ExemplarOptions,
    routeEdges: WeaveEdge[] = this.routeEdgesForFile(node.filePath),
  ): number {
    const subKind = options.subKind?.toLowerCase() ?? '';
    const identifier = `${node.symbolName} ${node.filePath}`;
    const lowerIdentifier = identifier.toLowerCase();
    const source = this.readProjectTextFile(node.filePath) ?? '';
    let score = 0;

    if (subKind && this.identifierContainsSubKind(identifier, subKind)) {
      score += 36;
    }
    if (this.subKindLooksReadOnly(subKind) && /(show|index|list|page)/.test(lowerIdentifier)) {
      score += 14;
    }
    if (this.subKindLooksMutating(subKind) && /(create|store|update|delete|patch|post|discover)/.test(lowerIdentifier)) {
      score += 14;
    }

    if (source.includes('function handle(') || source.includes('function handle (')) {
      score += 10;
    }
    if (source.includes('function authorize(') || source.includes('function authorize (')) {
      score += 6;
    }
    if (source.includes('Inertia::render')) {
      score += this.subKindLooksReadOnly(subKind) ? 12 : 4;
    }
    if (/ActionRequest|FormRequest/.test(source)) {
      score += this.subKindLooksMutating(subKind) ? 8 : 2;
    }

    const requestedMethods = new Set(
      [
        ...(options.routeMethod ? [options.routeMethod] : []),
        ...this.routeMethodsForSubKind(options.subKind),
      ]
        .map(method => method.toUpperCase())
        .filter(Boolean),
    );
    for (const edge of routeEdges) {
      const method = String(edge.metadata?.method ?? '').toUpperCase();
      if (requestedMethods.has(method)) {
        score += 18;
      }
      if (requestedMethods.has('MUTATION') && method && method !== 'GET') {
        score += 12;
      }
    }

    return score;
  }

  private getConsumerExemplarForContext(
    kind: string,
    contextNodeId: number,
  ): { nodeId: number; file: string; reason: string } | null {
    const contextNode = this.store.getNodeById(contextNodeId);
    if (!contextNode) {
      return null;
    }

    const candidates = new Map<number, number>();
    for (const edge of this.store.getEdgesTo(contextNodeId)) {
      if (!['renders_child', 'imports', 'uses_composable'].includes(edge.relationship)) {
        continue;
      }

      const source = this.store.getNodeById(edge.sourceId);
      if (!source || source.filePath === contextNode.filePath || this.isGeneratedPath(source.filePath)) {
        continue;
      }
      const sourceKind = this.normalizeKindAlias(source.kind);
      if (sourceKind !== kind && !(kind === 'component' && sourceKind === 'inertia_page')) {
        continue;
      }

      const current = candidates.get(source.id) ?? 0;
      const relationshipBonus = edge.relationship === 'renders_child' ? 30 : 18;
      candidates.set(source.id, current + relationshipBonus + this.bundleKindPriority(sourceKind) * 0.05);
    }

    const best = Array.from(candidates.entries())
      .map(([nodeId, score]) => ({ node: this.store.getNodeById(nodeId), score }))
      .filter((candidate): candidate is { node: WeaveNode; score: number } => Boolean(candidate.node))
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath))[0];

    if (!best) {
      return null;
    }

    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: `Best consumer exemplar for ${contextNode.filePath}`,
    };
  }

  private routeEdgesForFile(filePath: string): WeaveEdge[] {
    const routeEdges: WeaveEdge[] = [];
    for (const node of this.store.getNodesByFile(filePath)) {
      for (const edge of [...this.store.getEdgesFrom(node.id), ...this.store.getEdgesTo(node.id)]) {
        if (edge.relationship === 'routes_to') {
          routeEdges.push(edge);
        }
      }
    }
    return routeEdges;
  }

  private routeMethodsForSubKind(subKind: string | undefined): string[] {
    const normalized = subKind?.toLowerCase();
    if (!normalized) {
      return [];
    }
    if (this.subKindLooksReadOnly(normalized)) {
      return ['GET'];
    }
    if (this.subKindLooksMutating(normalized)) {
      return ['MUTATION', 'POST', 'PATCH', 'PUT', 'DELETE'];
    }
    return [];
  }

  private subKindLooksReadOnly(subKind: string): boolean {
    return ['show', 'index', 'list', 'read', 'get', 'page', 'render'].includes(subKind);
  }

  private subKindLooksMutating(subKind: string): boolean {
    return ['create', 'store', 'update', 'delete', 'mutation', 'post', 'patch', 'put'].includes(subKind);
  }

  private identifierContainsSubKind(value: string, subKind: string): boolean {
    const normalized = value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[\\/_.-]/g, ' ')
      .toLowerCase();
    return normalized.split(/\s+/).includes(subKind.toLowerCase());
  }

  private primaryKindForFile(filePath: string): string {
    const nodes = this.store.getNodesByFile(filePath)
      .filter(node => node.kind !== 'file')
      .sort((a, b) => this.bundleKindPriority(b.kind) - this.bundleKindPriority(a.kind) || a.lineStart - b.lineStart);

    return nodes[0]?.kind ?? this.inferKindForPath(filePath) ?? 'file';
  }

  private inferKindForPath(filePath: string): string | null {
    if (filePath.startsWith('app/Actions/')) return 'action';
    if (filePath.startsWith('app/Models/')) return 'model';
    if (/^app\/(?:Services|Clients|Integrations)\//.test(filePath)) return 'service';
    if (filePath.startsWith('database/migrations/')) return 'migration';
    if (filePath.startsWith('config/') && filePath.endsWith('.php')) return 'config_array';
    if (filePath.startsWith('app/Http/Requests/')) return 'form_request';
    if (isTestFilePath(filePath)) return 'test';
    if (filePath.startsWith('resources/js/Pages/') && filePath.endsWith('.vue')) return 'inertia_page';
    if (filePath.startsWith('resources/js/Components/') && filePath.endsWith('.vue')) return 'component';
    if (filePath.startsWith('resources/js/composables/') && /\/use[A-Z].*\.(?:js|ts)$/.test(filePath)) return 'composable';
    if (filePath.startsWith('routes/')) return 'route_definition';
    if (filePath.endsWith('.md')) return 'spec';
    return null;
  }

  private bundleKindPriority(kind: string): number {
    switch (kind) {
      case 'action':
        return 100;
      case 'model':
        return 98;
      case 'service':
        return 97;
      case 'migration':
        return 96;
      case 'config_array':
        return 95;
      case 'form_request':
      case 'test':
        return 94;
      case 'policy':
        return 92;
      case 'event':
      case 'listener':
        return 90;
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
      case 'spec':
        return 51;
      default:
        return 50;
    }
  }

  private auditBundleKindPriority(kind: string): number {
    switch (kind) {
      case 'action':
        return 100;
      case 'model':
        return 98;
      case 'service':
        return 97;
      case 'migration':
        return 97;
      case 'config_array':
      case 'test':
        return 95;
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
      provenance: ContextProvenance;
    },
    isStart: boolean,
  ): number {
    if (isStart) return 1;
    const bestReason = Math.max(...Array.from(entry.reasons.values()).map(reason => reason.confidence), 0.75);
    if (entry.provenance === 'spec_reference') {
      return Math.min(0.98, Math.max(0.9, bestReason));
    }
    if (entry.provenance === 'task_heuristic') {
      return Math.min(0.9, Math.max(0.72, bestReason));
    }
    return Math.min(0.98, Math.max(0.75, bestReason));
  }

  private edgeReasonConfidence(edge: { convention: string | null }, isFirstHop: boolean): number {
    if (edge.convention) {
      return isFirstHop ? 0.96 : 0.92;
    }
    return isFirstHop ? 0.93 : 0.88;
  }

  private kindConventionConfidence(kind: string): number {
    const conventions = this.conventionEngine.getConventions(this.normalizeKindAlias(kind));
    if (conventions.length === 0) {
      return 0.7;
    }
    return conventions.reduce((best, convention) => Math.max(best, convention.confidence), 0.7);
  }

  private pluginForConventionKind(kind: string): string | null {
    switch (this.normalizeKindAlias(kind)) {
      case 'action':
        return 'laravel-actions';
      case 'model':
      case 'migration':
      case 'form_request':
      case 'service':
      case 'config_array':
        return 'laravel-core';
      case 'inertia_page':
        return 'inertia';
      case 'component':
      case 'composable':
      case 'vue_template':
      case 'vue_script':
        return 'vue-composition';
      default:
        return null;
    }
  }

  private normalizeKindAlias(kind: string): string {
    const normalized = kind.toLowerCase();
    if (['page', 'inertia-page', 'inertia_page', 'vue_page'].includes(normalized)) {
      return 'inertia_page';
    }
    if (['request', 'form-request', 'form_request'].includes(normalized)) {
      return 'form_request';
    }
    if (['tests', 'test_file', 'spec_file'].includes(normalized)) {
      return 'test';
    }
    return kind;
  }

  private isGeneratedPath(filePath: string): boolean {
    return filePath.startsWith('public/build/') || filePath.startsWith('.weave/');
  }

  private isBootstrapNoisePath(filePath: string): boolean {
    return filePath === 'public/index.php';
  }

  private compactBootstrapContext(
    context: ContextBundle,
    specContext: BootstrapSpecContext | null,
  ): ContextBundle {
    return {
      workingSet: context.workingSet.map(file => ({
        file: file.file,
        kind: file.kind,
        kinds: file.kinds,
        confidence: file.confidence,
        provenance: file.provenance,
        reasons: file.reasons.slice(0, 2),
        anchors: file.anchors.slice(0, 1),
      })),
      constraints: context.constraints.slice(0, 6),
      exemplars: context.exemplars
        .slice(0, specContext?.likelyNewFileExemplars?.length ? 8 : 3)
        .map(exemplar => ({
          kind: exemplar.kind,
          file: exemplar.file,
          nodeId: exemplar.nodeId,
          plannedFile: exemplar.plannedFile,
          provenance: exemplar.provenance,
          confidence: exemplar.confidence,
          shapeMatchConfidence: exemplar.shapeMatchConfidence,
          coMentionConfidence: exemplar.coMentionConfidence,
          reason: exemplar.reason.length > 180 ? `${exemplar.reason.slice(0, 177)}...` : exemplar.reason,
        })),
    };
  }

  private compactBootstrapSpecContext(
    specContext: BootstrapSpecContext | null,
    query: BootstrapQuery,
  ): BootstrapSpecContext | null {
    if (!specContext) {
      return null;
    }

    const fileLimit = query.maxFiles ?? 10;
    const exemplarLimit = query.maxExemplars ?? 8;
    const referenceLimit = Math.max(12, Math.min(24, fileLimit * 2));

    return {
      ...specContext,
      referencedFiles: specContext.referencedFiles.slice(0, referenceLimit),
      lineReferences: specContext.lineReferences?.slice(0, fileLimit),
      lineAnchoredQueries: specContext.lineAnchoredQueries?.slice(0, fileLimit),
      existingFileEdges: undefined,
      existingFiles: specContext.existingFiles.slice(0, fileLimit),
      existingTargets: specContext.existingTargets?.slice(0, fileLimit),
      missingFiles: specContext.missingFiles.slice(0, referenceLimit),
      likelyNewFiles: specContext.likelyNewFiles.slice(0, referenceLimit),
      plannedFiles: specContext.plannedFiles?.slice(0, referenceLimit),
      staleSpecRefs: specContext.staleSpecRefs?.slice(0, referenceLimit),
      // This is the implementation manifest. Do not silently truncate it:
      // omitted planned files look like Weave has no opinion, which is exactly
      // the failure mode bootstrap is supposed to prevent.
      likelyNewFileExemplars: this.compactPlannedFileExemplars(specContext.likelyNewFileExemplars ?? []),
      plannedFilePatterns: this.compactPlannedFilePatterns(specContext.plannedFilePatterns ?? [], exemplarLimit),
      suspiciousReferences: specContext.suspiciousReferences.slice(0, referenceLimit),
      novelPathPrefixes: specContext.novelPathPrefixes.slice(0, fileLimit),
      terms: undefined,
      termIndex: undefined,
    };
  }

  private compactPlannedFileExemplars(
    exemplars: BootstrapPlannedFileExemplar[],
  ): BootstrapPlannedFileExemplar[] {
    return exemplars.map(exemplar => ({
      file: exemplar.file,
      kind: exemplar.kind,
      exemplarFile: exemplar.exemplarFile,
      exemplarNodeId: exemplar.exemplarNodeId,
      reason: exemplar.exemplarFile
        ? 'shape-bounded exemplar'
        : 'no indexed exemplar',
      confidence: exemplar.confidence,
      coMentionConfidence: exemplar.coMentionConfidence,
      shapeMatchConfidence: exemplar.shapeMatchConfidence,
    }));
  }

  private compactPlannedFilePatterns(
    patterns: BootstrapPlannedFilePattern[],
    limit: number,
  ): BootstrapPlannedFilePattern[] {
    return patterns
      .slice(0, limit)
      .map(pattern => ({
        file: pattern.file,
        kind: pattern.kind,
        role: pattern.role,
        status: pattern.status,
        confidence: pattern.confidence,
        directExemplarFile: pattern.directExemplarFile,
        constructionPatterns: [],
        configPatterns: [],
        usageExamples: [],
        notes: pattern.notes.slice(0, 2),
      }));
  }

  private buildBootstrapPrompt(
    task: string,
    start: string,
    entryCandidates: BootstrapEntryCandidate[],
    context: ContextBundle,
    guidance: string[],
    fallbackPolicy: string[],
    specContext: BootstrapSpecContext | null = null,
    compact = false,
  ): string {
    if (compact) {
      return this.buildCompactBootstrapPrompt(
        task,
        start,
        entryCandidates,
        context,
        guidance,
        fallbackPolicy,
        specContext,
      );
    }

    const omitGenericExemplars = Boolean(specContext?.likelyNewFileExemplars?.length);
    const promptContext = omitGenericExemplars
      ? { ...context, exemplars: [] }
      : context;
    const contextPayload = promptContext;

    return [
      'You are operating in Weave-first mode.',
      `Task: ${task}`,
      `Entry file: ${start}`,
      ...(specContext
	        ? [
	            `Spec file: ${specContext.file}`,
	            `Spec digest: ${this.specContextDigest(specContext)}`,
	            `Spec existing references: ${specContext.existingFiles.length}`,
            `Spec missing/new references: ${specContext.missingFiles.length}`,
            ...(specContext.lineAnchoredQueries?.length
              ? [
                  'Spec line-anchored query targets:',
                  ...specContext.lineAnchoredQueries.slice(0, 8).map(query =>
                    `- weave_query ${query.query}`,
                  ),
                ]
              : []),
            ...(specContext.likelyNewFileExemplars?.length
	              ? [
	                  'Spec planned-file exemplars:',
	                  ...specContext.likelyNewFileExemplars.slice(0, 8).map(exemplar =>
	                    `- ${exemplar.file} (${exemplar.kind ?? 'unknown'}): ${exemplar.exemplarFile ?? 'no exemplar'}; shape=${this.formatConfidence(exemplar.shapeMatchConfidence)} coMention=${this.formatConfidence(exemplar.coMentionConfidence)}`,
	                  ),
	                ]
              : []),
            ...(specContext.plannedFilePatterns?.length
              ? [
                  'Spec planned-file pattern evidence:',
                  ...specContext.plannedFilePatterns.slice(0, 8).map(pattern =>
                    `- ${pattern.file} (${pattern.role?.primary ?? pattern.kind ?? 'unknown'}): ${pattern.status}; ${pattern.notes.join(' ')}`,
                  ),
                ]
              : []),
            ...(specContext.existingFileEdges?.length
              ? [
                  'Spec existing-file graph edges:',
                  ...specContext.existingFileEdges.slice(0, 8).map(summary =>
                    `- ${summary.file}: ${summary.edges.slice(0, 3).map(edge =>
                      `${edge.direction} ${edge.relationship} ${edge.direction === 'outgoing' ? `to ${edge.targetFile}` : `from ${edge.sourceFile}`}`,
                    ).join('; ')}`,
                  ),
                ]
              : []),
            ...(omitGenericExemplars
              ? ['Generic context exemplars omitted from this prompt because spec planned-file exemplars are more specific.']
              : []),
          ]
        : []),
      '',
      'Inferred entry candidates:',
      ...entryCandidates.map(candidate => `- ${candidate.file} (${Math.round(candidate.confidence * 100)}%): ${candidate.reasons.join('; ')}`),
      ...(specContext?.novelPathPrefixes.length
        ? ['', 'Spec path warnings:', ...specContext.novelPathPrefixes.map(prefix => `- New path prefix: ${prefix}`)]
        : []),
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
      JSON.stringify(contextPayload, null, 2),
    ].join('\n');
  }

  private buildCompactBootstrapPrompt(
    task: string,
    start: string,
    entryCandidates: BootstrapEntryCandidate[],
    context: ContextBundle,
    guidance: string[],
    fallbackPolicy: string[],
    specContext: BootstrapSpecContext | null,
  ): string {
    const lines = [
      'Weave bootstrap summary.',
      `Task: ${task}`,
      `Entry: ${start}`,
    ];

    if (specContext) {
      lines.push(
        `Spec: ${specContext.file}`,
        `Digest: ${this.specContextDigest(specContext)}`,
      );
      const lineQueries = specContext.lineAnchoredQueries ?? [];
      if (lineQueries.length > 0) {
        lines.push(`Line anchors: ${lineQueries.slice(0, 4).map(query => query.query).join(', ')}`);
      }
      const exemplars = specContext.likelyNewFileExemplars ?? [];
      if (exemplars.length > 0) {
        lines.push(`Planned file exemplars: ${exemplars.length} entries in spec.likelyNewFileExemplars.`);
      }
    }

    lines.push(
      `Working set count: ${context.workingSet.length}`,
      `Constraint count: ${context.constraints.length}`,
      `Entry candidates: ${entryCandidates.map(candidate => `${candidate.file} ${Math.round(candidate.confidence * 100)}%`).join(', ')}`,
      `Use top-level workingSet/constraints/exemplars. Widen only if fallback policy applies.`,
    );

    return lines.join('\n');
  }

  private buildSpecContext(specInput: string): BootstrapSpecContext {
    const specSource = this.resolveSpecInput(specInput);
    const { file, content } = specSource;

    const specReferences = this.extractSpecReferences(content, file);
    const referencedFiles = this.dedupeDefaultInferredSpecReferences(specReferences.files);
    const lineReferences = specReferences.lineReferences;
    const lineAnchoredQueries = this.buildLineAnchoredQueries(lineReferences);
    const existingFiles: string[] = [];
    const missingFiles: string[] = [];
    const likelyNewFiles: string[] = [];
    const suspiciousReferences: string[] = [];

    for (const referencedFile of referencedFiles) {
      if (existsSync(join(this.projectRoot, referencedFile))) {
        existingFiles.push(referencedFile);
      } else if (this.looksLikeProjectFilePath(referencedFile)) {
        likelyNewFiles.push(referencedFile);
        missingFiles.push(referencedFile);
      } else {
        suspiciousReferences.push(referencedFile);
        missingFiles.push(referencedFile);
      }
    }

    const contextualBareReferences = this.contextualBareSpecReferences(
      suspiciousReferences,
      [...existingFiles, ...likelyNewFiles],
    );
    const actionableSuspiciousReferences = suspiciousReferences
      .filter(file => !contextualBareReferences.has(file));
    const actionableMissingFiles = missingFiles
      .filter(file => !contextualBareReferences.has(file));
    const novelPathPrefixes = this.findNovelPathPrefixes(likelyNewFiles);
    const termIndex = this.significantTaskTerms(this.extractTaskTerms(content));
    const terms = termIndex.slice(0, 40);
    const likelyNewFileExemplars = this.buildLikelyNewFileExemplars(likelyNewFiles, existingFiles);
    const plannedFilePatterns = this.buildPlannedFilePatterns(likelyNewFiles, likelyNewFileExemplars);
    const existingFileEdges = this.buildExistingFileEdgeSummaries(existingFiles);

    const context: BootstrapSpecContext = {
      file,
      referencedFiles,
      lineReferences,
      lineAnchoredQueries,
      existingFileEdges,
      existingFiles,
      existingTargets: existingFiles,
      missingFiles: actionableMissingFiles,
      likelyNewFiles,
      plannedFiles: likelyNewFiles,
      staleSpecRefs: actionableSuspiciousReferences,
      likelyNewFileExemplars,
      plannedFilePatterns,
      suspiciousReferences: actionableSuspiciousReferences,
      novelPathPrefixes,
      mentionsTests: this.specTextMentionsTests(content),
      terms,
    };

    Object.defineProperty(context, 'termIndex', {
      value: termIndex,
      enumerable: false,
    });

    return context;
  }

  private buildLineAnchoredQueries(
    lineReferences: BootstrapSpecLineReference[],
  ): BootstrapSpecLineAnchoredQuery[] {
    return lineReferences.map(reference => ({
      file: reference.file,
      lineStart: reference.lineStart,
      ...(reference.lineEnd ? { lineEnd: reference.lineEnd } : {}),
      query: `${reference.file}:${reference.lineStart}${reference.lineEnd ? `-${reference.lineEnd}` : ''}`,
    }));
  }

  private buildExistingFileEdgeSummaries(files: string[]): BootstrapSpecContext['existingFileEdges'] {
    return files
      .map(file => {
        const nodes = this.store.getNodesByFile(file);
        const edges = this.collectFileEdgeSummaries(nodes);
        const visibleEdges = edges.slice(0, 8);
        return {
          file,
          edges: visibleEdges,
          totalEdges: edges.length,
          omittedEdges: Math.max(0, edges.length - visibleEdges.length),
        };
      })
      .filter(summary => summary.edges.length > 0);
  }

  private collectFileEdgeSummaries(nodes: WeaveNode[]): BootstrapExistingFileEdge[] {
    const summaries = new Map<string, { edge: BootstrapExistingFileEdge; priority: number }>();
    const nodeIds = new Set(nodes.map(node => node.id));

    for (const node of nodes) {
      for (const edge of this.store.getEdgesFrom(node.id)) {
        const target = this.store.getNodeById(edge.targetId);
        if (!target || this.isGeneratedPath(target.filePath)) continue;
        this.addEdgeSummary(summaries, edge, node, target, 'outgoing', nodeIds);
      }
      for (const edge of this.store.getEdgesTo(node.id)) {
        const source = this.store.getNodeById(edge.sourceId);
        if (!source || this.isGeneratedPath(source.filePath)) continue;
        this.addEdgeSummary(summaries, edge, source, node, 'incoming', nodeIds);
      }
    }

    return Array.from(summaries.values())
      .sort((a, b) => b.priority - a.priority || a.edge.relationship.localeCompare(b.edge.relationship))
      .map(entry => entry.edge);
  }

  private addEdgeSummary(
    summaries: Map<string, { edge: BootstrapExistingFileEdge; priority: number }>,
    edge: WeaveEdge,
    source: WeaveNode,
    target: WeaveNode,
    direction: 'incoming' | 'outgoing',
    fileNodeIds: Set<number>,
  ): void {
    if (source.filePath === target.filePath) {
      return;
    }

    const key = `${direction}:${edge.relationship}:${source.filePath}:${source.symbolName}:${target.filePath}:${target.symbolName}`;
    const summary: BootstrapExistingFileEdge = {
      direction,
      relationship: edge.relationship,
      convention: edge.convention,
      sourceFile: source.filePath,
      sourceSymbol: source.symbolName,
      sourceKind: source.kind,
      targetFile: target.filePath,
      targetSymbol: target.symbolName,
      targetKind: target.kind,
    };
    const metadata = this.edgeMetadataPreview(edge.metadata);
    if (metadata && Object.keys(metadata).length > 0) {
      summary.metadata = metadata;
    }

    const priority = this.edgeSummaryPriority(edge, source, target, fileNodeIds);
    const existing = summaries.get(key);
    if (!existing || priority > existing.priority) {
      summaries.set(key, { edge: summary, priority });
    }
  }

  private edgeSummaryPriority(
    edge: WeaveEdge,
    source: WeaveNode,
    target: WeaveNode,
    fileNodeIds: Set<number>,
  ): number {
    const relationshipPriority: Record<string, number> = {
      renders: 100,
      routes_to: 96,
      shares_data: 92,
      navigates_to: 86,
      renders_child: 82,
      uses_composable: 78,
      imports: 70,
      belongs_to: 66,
      has_many: 66,
      belongs_to_many: 66,
      calls: 58,
    };
    let score = relationshipPriority[edge.relationship] ?? 40;
    if (edge.convention) score += 4;
    if (fileNodeIds.has(source.id) || fileNodeIds.has(target.id)) score += 2;
    if (source.kind === 'file' || target.kind === 'file') score -= 4;
    return score;
  }

  private edgeMetadataPreview(metadata: Record<string, unknown> | null): Record<string, unknown> | undefined {
    if (!metadata) {
      return undefined;
    }

    const preview: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (value === null || value === undefined) continue;
      if (key === 'props' && typeof value === 'string') {
        const propKeys = this.extractPhpArrayKeys(value);
        preview[key] = propKeys.length > 0 ? propKeys : this.truncateMetadataString(value);
        continue;
      }
      preview[key] = typeof value === 'string' ? this.truncateMetadataString(value) : value;
    }
    return preview;
  }

  private formatConfidence(value: number | undefined): string {
    return value === undefined ? 'n/a' : value.toFixed(2);
  }

  private extractPhpArrayKeys(value: string): string[] {
    const keys = new Set<string>();
    for (const match of value.matchAll(/['"]([^'"]+)['"]\s*=>/g)) {
      keys.add(match[1]);
    }
    return Array.from(keys).slice(0, 20);
  }

  private truncateMetadataString(value: string): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
  }

  private buildLikelyNewFileExemplars(
    files: string[],
    specExistingFiles: string[] = [],
  ): BootstrapPlannedFileExemplar[] {
    return files.map(file => {
      const kind = this.inferKindForPath(file);
      if (!kind) {
	        return {
	          file,
	          kind: null,
	          exemplarFile: null,
	          exemplarNodeId: null,
	          reason: 'No kind inferred from planned file path.',
	          confidence: 0,
	          coMentionConfidence: 0,
	          shapeMatchConfidence: 0,
	          confidenceReason: 'No planned-file kind could be inferred from the path.',
	        };
	      }

      const exemplar = this.exemplarForPlannedFile(file, kind, specExistingFiles);
      if (!exemplar) {
	        return {
	          file,
	          kind,
	          exemplarFile: null,
	          exemplarNodeId: null,
	          reason: `No indexed exemplar found for planned ${kind}.`,
	          confidence: 0.35,
	          coMentionConfidence: 0,
	          shapeMatchConfidence: 0,
	          confidenceReason: 'No indexed shape exemplar was found; confidence reflects an evidence gap.',
	        };
	      }

      if (exemplar.confidence < PLANNED_EXEMPLAR_CONFIDENCE_FLOOR) {
        return {
          file,
          kind,
          exemplarFile: null,
          exemplarNodeId: null,
          reason: `No reliable exemplar found for planned ${kind}; best candidate ${exemplar.file} scored below the confidence floor.`,
          confidence: exemplar.confidence,
          coMentionConfidence: exemplar.coMentionConfidence,
          shapeMatchConfidence: exemplar.shapeMatchConfidence,
          confidenceReason: `${exemplar.confidenceReason} Suppressed ${exemplar.file} because confidence ${exemplar.confidence.toFixed(2)} is below ${PLANNED_EXEMPLAR_CONFIDENCE_FLOOR.toFixed(2)}.`,
        };
      }

      return {
        file,
        kind,
	        exemplarFile: exemplar.file,
	        exemplarNodeId: exemplar.nodeId,
	        reason: exemplar.reason,
	        confidence: exemplar.confidence,
	        coMentionConfidence: exemplar.coMentionConfidence,
	        shapeMatchConfidence: exemplar.shapeMatchConfidence,
	        confidenceReason: exemplar.confidenceReason,
	      };
    });
  }

  private buildPlannedFilePatterns(
    files: string[],
    exemplars: BootstrapPlannedFileExemplar[],
  ): BootstrapPlannedFilePattern[] {
    const exemplarByFile = new Map(exemplars.map(exemplar => [exemplar.file, exemplar]));
    return files
      .map(file => {
        const kind = this.inferKindForPath(file);
        if (kind === 'service') {
          return this.buildServicePatternSummary(file, exemplarByFile.get(file));
        }
        return null;
      })
      .filter((pattern): pattern is BootstrapPlannedFilePattern => pattern !== null);
  }

  private buildServicePatternSummary(
    file: string,
    exemplar?: BootstrapPlannedFileExemplar,
  ): BootstrapPlannedFilePattern {
    const role = this.serviceRoleForFile(file);
    const directExemplarFile = exemplar?.exemplarFile ?? null;
    const constructionPatterns = this.serviceConstructionEvidence();
    const configPatterns = this.serviceConfigEvidence(role);
    const usageExamples = this.serviceUsageEvidence(role, directExemplarFile);
    const adjacentEvidenceCount = constructionPatterns.length + configPatterns.length + usageExamples.length;
    const hasDirectExemplar = Boolean(directExemplarFile);
    const status = hasDirectExemplar
      ? 'direct_exemplar'
      : adjacentEvidenceCount > 0
        ? 'adjacent_evidence'
        : 'evidence_gap';
    const notes = [
      hasDirectExemplar
        ? `Use ${directExemplarFile} as the direct ${role.primary} exemplar.`
        : `No role-compatible ${role.primary} exemplar found; do not copy an unrelated service/client as the primary shape.`,
      constructionPatterns.length > 0
        ? 'Use construction evidence only for wiring style, not as an implementation template.'
        : 'No indexed construction evidence found for services.',
      configPatterns.length > 0
        ? 'Config evidence is adjacent; verify whether this planned service should read config.'
        : 'No relevant config evidence found.',
    ];

    return {
      file,
      kind: 'service',
      role,
      status,
      confidence: hasDirectExemplar
        ? exemplar?.confidence ?? 0.85
        : adjacentEvidenceCount > 0
          ? 0.55
          : 0.2,
      directExemplarFile,
      constructionPatterns,
      configPatterns,
      usageExamples,
      notes,
    };
  }

  private serviceConstructionEvidence(): BootstrapPatternEvidence[] {
    const evidence: BootstrapPatternEvidence[] = [];
    const sourceFiles = this.indexedProjectFiles()
      .filter(file => /\.(php|ts|js)$/i.test(file))
      .filter(file => /^(app|src|routes|config)\//.test(file))
      .filter(file => !this.isGeneratedPath(file));

    const constructorInjectionFiles = this.filesMatchingSourcePattern(
      sourceFiles,
      /\b__construct\s*\([^)]*(?:private|protected|public)?\s*[\\A-Za-z_][\\A-Za-z0-9_]*\s+\$\w+/,
      5,
    );
    if (constructorInjectionFiles.length > 0) {
      evidence.push({
        pattern: 'constructor_injection',
        confidence: 0.72,
        files: constructorInjectionFiles,
        reason: 'Classes receive typed dependencies through constructors.',
      });
    }

    const serviceProviderFiles = this.filesMatchingSourcePattern(
      sourceFiles,
      /(?:\$this->app|app\(\))->(?:singleton|bind|scoped|instance)\s*\(/,
      5,
    );
    if (serviceProviderFiles.length > 0) {
      evidence.push({
        pattern: 'container_binding',
        confidence: 0.78,
        files: serviceProviderFiles,
        reason: 'Application services are registered through container binding calls.',
      });
    }

    const directInstantiationFiles = this.filesMatchingSourcePattern(
      sourceFiles,
      /\bnew\s+[A-Z][A-Za-z0-9_]*(?:Service|Client|Registry|Repository|Resolver|Manager|Builder|Gateway|Adapter)\b/,
      5,
    );
    if (directInstantiationFiles.length > 0) {
      evidence.push({
        pattern: 'direct_instantiation',
        confidence: 0.5,
        files: directInstantiationFiles,
        reason: 'Some service-like collaborators are directly instantiated.',
      });
    }

    return evidence;
  }

  private serviceConfigEvidence(role: { family: string; primary: string }): BootstrapPatternEvidence[] {
    const evidence: BootstrapPatternEvidence[] = [];
    const sourceFiles = this.indexedProjectFiles()
      .filter(file => /\.(php|ts|js)$/i.test(file))
      .filter(file => /^(app|src|config)\//.test(file))
      .filter(file => !this.isGeneratedPath(file));
    const configCallFiles = this.filesMatchingSourcePattern(sourceFiles, /\bconfig\s*\(\s*['"][^'"]+['"]/, 5);
    if (configCallFiles.length > 0) {
      evidence.push({
        pattern: 'config_lookup',
        confidence: 0.64,
        files: configCallFiles,
        reason: 'Code reads framework/application config values.',
      });
    }

    const configFiles = this.indexedProjectFiles()
      .filter(file => file.startsWith('config/') && file.endsWith('.php'))
      .filter(file => !this.isGeneratedPath(file));
    const roleConfigFiles = configFiles
      .filter(file => {
        const lower = file.toLowerCase();
        return lower.includes(role.primary) || lower.includes(role.family.replace(/s$/, ''));
      })
      .slice(0, 5);
    if (roleConfigFiles.length > 0) {
      evidence.push({
        pattern: 'role_config_file',
        confidence: 0.58,
        files: roleConfigFiles,
        reason: `Config files mention the ${role.primary} role or ${role.family} family.`,
      });
    } else if (configFiles.length > 0) {
      evidence.push({
        pattern: 'config_array_files',
        confidence: 0.42,
        files: configFiles.slice(0, 5),
        reason: 'Config array files exist, but none are role-specific for this planned service.',
      });
    }

    return evidence;
  }

  private serviceUsageEvidence(
    role: { family: string; primary: string },
    directExemplarFile: string | null,
  ): BootstrapPatternEvidence[] {
    const evidence: BootstrapPatternEvidence[] = [];
    if (directExemplarFile) {
      const directConsumers = this.consumerFilesForServiceFile(directExemplarFile).slice(0, 5);
      if (directConsumers.length > 0) {
        evidence.push({
          pattern: 'direct_exemplar_consumers',
          confidence: 0.82,
          files: directConsumers,
          reason: `Files that consume the direct ${role.primary} exemplar.`,
        });
      }
    }

    const compatibleServiceFiles = this.store.getAllNodes()
      .filter(node => ['service', 'class'].includes(node.kind))
      .filter(node => this.serviceRolesAreCompatible(role, this.serviceRoleForNode(node)))
      .map(node => node.filePath)
      .filter((file, index, files) => files.indexOf(file) === index)
      .filter(file => file !== directExemplarFile)
      .slice(0, 5);
    if (compatibleServiceFiles.length > 0) {
      evidence.push({
        pattern: 'same_role_service_files',
        confidence: 0.7,
        files: compatibleServiceFiles,
        reason: `Existing service-like files share the ${role.primary} role.`,
      });
    }

    const serviceConsumerFiles = this.filesMatchingSourcePattern(
      this.indexedProjectFiles()
        .filter(file => /\.(php|ts|js)$/i.test(file))
        .filter(file => /^(app|src)\//.test(file))
        .filter(file => !this.isGeneratedPath(file)),
      /\b(?:Service|Client|Registry|Repository|Resolver|Manager|Builder|Gateway|Adapter)\b/,
      5,
    );
    if (serviceConsumerFiles.length > 0) {
      evidence.push({
        pattern: 'service_collaborator_usage',
        confidence: 0.52,
        files: serviceConsumerFiles,
        reason: 'Application code references service-like collaborators.',
      });
    }

    if (['registry', 'resolver', 'repository', 'manager'].includes(role.primary)) {
      const gatekeeperFiles = this.filesMatchingSourcePattern(
        this.indexedProjectFiles()
          .filter(file => /\.(php|ts|js)$/i.test(file))
          .filter(file => /^(app|src|config)\//.test(file))
          .filter(file => !this.isGeneratedPath(file)),
        /\b(?:validate[A-Z]\w*|resolve[A-Z]\w*|find[A-Z]\w*|lookup[A-Z]\w*|get[A-Z]\w*|all[A-Z]\w*)\s*\(/,
        5,
      );
      if (gatekeeperFiles.length > 0) {
        evidence.push({
          pattern: 'gatekeeper_or_lookup_methods',
          confidence: 0.48,
          files: gatekeeperFiles,
          reason: `Nearby code exposes lookup/validation methods that may inform a ${role.primary} service API.`,
        });
      }
    }

    return evidence;
  }

  private consumerFilesForServiceFile(file: string): string[] {
    const nodes = this.store.getNodesByFile(file);
    const consumers = new Set<string>();
    for (const node of nodes) {
      for (const edge of this.store.getEdgesTo(node.id)) {
        const source = this.store.getNodeById(edge.sourceId);
        if (source && source.filePath !== file && !this.isGeneratedPath(source.filePath)) {
          consumers.add(source.filePath);
        }
      }
    }
    return Array.from(consumers).sort();
  }

  private filesMatchingSourcePattern(
    files: string[],
    pattern: RegExp,
    limit: number,
  ): string[] {
    const matches: string[] = [];
    for (const file of files) {
      const source = this.readProjectTextFile(file);
      if (!source || !pattern.test(source)) {
        continue;
      }
      matches.push(file);
      if (matches.length >= limit) {
        break;
      }
    }
    return matches;
  }

  private exemplarOptionsForPlannedFile(file: string, kind: string): ExemplarOptions {
    if (kind !== 'action') {
      if (kind === 'component') {
        const name = basename(file).toLowerCase();
        if (/modal|dialog/.test(name)) {
          return { subKind: 'modal' };
        }
        if (/layout|shell/.test(name)) {
          return { subKind: 'layout' };
        }
        if (/form/.test(name)) {
          return { subKind: 'form' };
        }
        if (/table|list/.test(name)) {
          return { subKind: 'list' };
        }
        return { subKind: 'leaf' };
      }
      return {};
    }

    const name = basename(file, '.php').toLowerCase();
    if (/^(show|get|view)/.test(name)) {
      return { subKind: 'show', routeMethod: 'GET' };
    }
    if (/^(list|index)/.test(name)) {
      return { subKind: 'index', routeMethod: 'GET' };
    }
    if (/^(create|store|discover|add)/.test(name)) {
      return { subKind: 'create', routeMethod: 'POST' };
    }
    if (/^(update|patch)/.test(name)) {
      return { subKind: 'update', routeMethod: 'PATCH' };
    }
    if (/^(delete|destroy|remove)/.test(name)) {
      return { subKind: 'delete', routeMethod: 'DELETE' };
    }
    return {};
  }

  private exemplarForPlannedFile(
    file: string,
    kind: string,
    specExistingFiles: string[] = [],
  ): PlannedFileExemplarCandidate | null {
    const specMentioned = this.getSpecMentionedExemplarForPlannedFile(file, kind, specExistingFiles);
    if (specMentioned && specMentioned.confidence >= 0.75) {
      return specMentioned;
    }

    let fallback: PlannedFileExemplarCandidate | null = null;
    if (kind === 'inertia_page') {
      const pageExemplar = this.getInertiaPageExemplarForPlannedFile(file);
      if (pageExemplar) {
        fallback = this.toPlannedFileExemplarCandidate(file, kind, pageExemplar, 0);
      }
    } else if (kind === 'service') {
      const serviceExemplar = this.getServiceLikeExemplarForPlannedFile(file);
      if (serviceExemplar) {
        fallback = this.toPlannedFileExemplarCandidate(file, kind, serviceExemplar, 0);
      } else {
        return specMentioned;
      }
    } else if (kind === 'config_array') {
      const configExemplar = this.getConfigArrayExemplarForPlannedFile(file);
      if (configExemplar) {
        fallback = this.toPlannedFileExemplarCandidate(file, kind, configExemplar, 0);
      } else {
        return specMentioned;
      }
    } else {
      const exemplar = this.exemplar(kind, undefined, this.exemplarOptionsForPlannedFile(file, kind));
      fallback = exemplar
        ? this.toPlannedFileExemplarCandidate(file, kind, exemplar, 0)
        : null;
    }

    if (!fallback) {
      return specMentioned;
    }

    if (!specMentioned || fallback.confidence >= specMentioned.confidence) {
      return fallback;
    }

    return specMentioned;
  }

  private toPlannedFileExemplarCandidate(
    plannedFile: string,
    kind: string,
    exemplar: { nodeId: number; file: string; reason: string },
    coMentionConfidence: number,
  ): PlannedFileExemplarCandidate {
    const node = this.store.getNodeById(exemplar.nodeId)
      ?? this.store.getNodesByFile(exemplar.file)
        .find(candidate => this.normalizeKindAlias(candidate.kind) === this.normalizeKindAlias(kind));
    const shapeMatchConfidence = node
      ? this.shapeMatchConfidenceForPlannedFile(plannedFile, kind, node)
      : Math.min(0.75, this.kindConventionConfidence(kind));
    const confidence = Math.min(this.kindConventionConfidence(kind), Math.max(0.2, shapeMatchConfidence));
    return {
      ...exemplar,
      confidence,
      coMentionConfidence,
      shapeMatchConfidence,
      confidenceReason: coMentionConfidence > 0
        ? 'Confidence is bounded by structural shape match; spec co-mention alone is not treated as imitation evidence.'
        : 'Confidence is based on structural shape and mined kind conventions.',
    };
  }

  private shapeMatchConfidenceForPlannedFile(
    plannedFile: string,
    kind: string,
    candidate: WeaveNode,
  ): number {
    const normalizedKind = this.normalizeKindAlias(kind);
    const candidateKind = this.normalizeKindAlias(candidate.kind);
    const options = this.exemplarOptionsForPlannedFile(plannedFile, normalizedKind);
    const pathScore = Math.min(
      0.22,
      this.sharedPathSegmentCount(
        this.pathSegmentsForSimilarity(plannedFile),
        this.pathSegmentsForSimilarity(candidate.filePath),
      ) * 0.055,
    );
    const sameKindScore = candidateKind === normalizedKind ? 0.25 : 0.08;

    if (normalizedKind === 'composable') {
      const composableScore = this.composableShapeScore(candidate, plannedFile);
      const composablePathScore = Math.min(0.1, pathScore);
      const confidence = 0.08
        + (candidateKind === normalizedKind ? 0.14 : 0.04)
        + composablePathScore
        + Math.min(0.62, composableScore / 150);
      return Math.max(0.05, Math.min(1, Number(confidence.toFixed(2))));
    }

    let shapeScore = 0.15 + pathScore + sameKindScore;

    if (normalizedKind === 'component' && options.subKind) {
      shapeScore += Math.min(0.48, this.componentShapeScore(candidate, options.subKind.toLowerCase()) / 100);
    } else if (normalizedKind === 'action') {
      shapeScore += Math.min(0.52, this.actionShapeScore(candidate, options) / 110);
    } else if (normalizedKind === 'inertia_page') {
      if (candidate.filePath.startsWith('resources/js/Pages/')) shapeScore += 0.28;
      if (candidate.filePath.includes('/Admin/') === plannedFile.includes('/Admin/')) shapeScore += 0.12;
    } else if (normalizedKind === 'service') {
      const plannedRole = this.serviceRoleForFile(plannedFile);
      const candidateRole = this.serviceRoleForNode(candidate);
      if (plannedRole.primary === candidateRole.primary) shapeScore += 0.32;
      if (plannedRole.family === candidateRole.family) shapeScore += 0.12;
    } else if (normalizedKind === 'config_array') {
      if (this.configSectionForFile(plannedFile) === this.configSectionForFile(candidate.filePath)) {
        shapeScore += 0.36;
      }
    } else if (normalizedKind === 'test') {
      if (this.testFamilyForFile(plannedFile) === this.testFamilyForFile(candidate.filePath)) {
        shapeScore += 0.32;
      }
      if (this.testSubjectTokens(plannedFile).some(token => this.testSubjectTokens(candidate.filePath).includes(token))) {
        shapeScore += 0.16;
      }
    }

    return Math.max(0.05, Math.min(1, Number(shapeScore.toFixed(2))));
  }

  private testFamilyForFile(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/feature/')) return 'feature';
    if (normalized.includes('/unit/')) return 'unit';
    if (normalized.includes('/browser/')) return 'browser';
    if (normalized.includes('/e2e/')) return 'e2e';
    if (normalized.includes('/integration/')) return 'integration';
    return normalized.startsWith('tests/') || normalized.startsWith('test/') ? 'test' : 'source-adjacent';
  }

  private testSubjectTokens(filePath: string): string[] {
    return basename(filePath, extname(filePath))
      .replace(/\.(?:test|spec)$/i, '')
      .replace(/(?:Test|Spec)$/i, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 3 && !['test', 'spec', 'feature', 'unit'].includes(token));
  }

  private composableShapeScore(node: WeaveNode, plannedFile: string): number {
    const source = this.readProjectTextFile(node.filePath) ?? '';
    const plannedIdentifier = basename(plannedFile, extname(plannedFile));
    let score = 0;
    if (node.filePath.startsWith('resources/js/composables/')) score += 18;
    if (/^use[A-Z]/.test(node.symbolName) || /^use[A-Z]/.test(basename(node.filePath, extname(node.filePath)))) score += 18;
    if (source.includes('return {')) score += 14;
    if (/\bonUnmounted\s*\(/.test(source)) score += 14;
    if (/\b(ref|computed|watch)\s*\(/.test(source)) score += 8;
    const plannedMutation = /unlock|discover|save|update|create|post/i.test(plannedIdentifier);
    const hasMutationSurface = /\b(fetch|router\.(?:post|put|patch|delete)|axios|postWithKeepalive)\s*\(/.test(source);
    if (hasMutationSurface) score += plannedMutation ? 24 : 6;
    else if (plannedMutation) score -= 45;
    const plannedTimer = /typing|timer|debounce|interval/i.test(plannedIdentifier);
    const hasTimerSurface = /\btimers?\b|setTimeout|setInterval|clearTimeout|clearInterval/.test(source);
    if (hasTimerSurface) score += plannedTimer ? 24 : 4;
    else if (plannedTimer) score -= 30;
    const plannedMatcher = /matcher|regex|regexp|pattern|parser|tokenizer/i.test(plannedIdentifier);
    const hasMatcherSurface = /\b(?:RegExp|matchAll|match|replace|split|includes|startsWith|endsWith)\s*\(/.test(source);
    if (hasMatcherSurface) score += plannedMatcher ? 24 : 4;
    else if (plannedMatcher) score -= 45;
    return score;
  }

  private getConfigArrayExemplarForPlannedFile(file: string): {
    nodeId: number;
    file: string;
    reason: string;
  } | null {
    const plannedSection = this.configSectionForFile(file);
    const candidates = this.store.getNodesByKind('config_array')
      .filter(node => !this.isGeneratedPath(node.filePath))
      .map(node => {
        const section = this.configSectionForFile(node.filePath);
        if (section !== plannedSection) {
          return null;
        }
        const score = 40
          + this.sharedPathSegmentCount(
            this.pathSegmentsForSimilarity(file),
            this.pathSegmentsForSimilarity(node.filePath),
          ) * 12;
        return { node, score };
      })
      .filter((candidate): candidate is { node: WeaveNode; score: number } => Boolean(candidate))
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    const best = candidates[0];
    if (!best) {
      return null;
    }

    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: `Closest config-array exemplar under ${plannedSection}`,
    };
  }

  private configSectionForFile(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/^config\/([^/]+)/);
    return match?.[1] ?? 'root';
  }

  private getServiceLikeExemplarForPlannedFile(file: string): {
    nodeId: number;
    file: string;
    reason: string;
  } | null {
    const plannedSegments = this.pathSegmentsForSimilarity(file);
    const plannedRole = this.serviceRoleForFile(file);
    const serviceLikeName = /(service|client|integration|gateway|adapter|manager|registry|repository|resolver|builder)/i;
    const candidates = this.store.getAllNodes()
      .filter(node => !this.isGeneratedPath(node.filePath))
      .filter(node => ['service', 'class'].includes(node.kind))
      .filter(node =>
        /^(?:app|src)\/(?:Services|Clients|Integrations|Support|Lib|Domain)\//.test(node.filePath)
        || serviceLikeName.test(`${node.symbolName} ${node.filePath}`),
      )
      .filter(node => this.serviceRolesAreCompatible(plannedRole, this.serviceRoleForNode(node)))
      .map(node => {
        let score = node.kind === 'service' ? 40 : 24;
        const candidateRole = this.serviceRoleForNode(node);
        if (candidateRole.primary === plannedRole.primary) score += 28;
        if (candidateRole.family === plannedRole.family) score += 16;
        if (serviceLikeName.test(node.symbolName)) score += 12;
        if (/^(?:app|src)\/(?:Services|Clients|Integrations)\//.test(node.filePath)) score += 16;
        score += this.sharedPathSegmentCount(plannedSegments, this.pathSegmentsForSimilarity(node.filePath)) * 8;
        return { node, score };
      })
      .filter(candidate => candidate.score >= 70)
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    const best = candidates[0];
    if (!best) {
      return null;
    }

    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: `Closest ${plannedRole.primary} service exemplar by role and path similarity`,
    };
  }

  private serviceRoleForNode(node: WeaveNode): { family: string; primary: string } {
    return this.serviceRoleForFile(node.filePath, node.symbolName);
  }

  private serviceRoleForFile(filePath: string, symbolName = basename(filePath, extname(filePath))): {
    family: string;
    primary: string;
  } {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const symbol = symbolName.toLowerCase();
    const identifier = `${symbolName} ${normalizedPath}`.toLowerCase();
    const family = normalizedPath.match(/^(?:app|src)\/([^/]+)\//)?.[1]?.toLowerCase() ?? 'unknown';
    const rolePatterns: Array<[string, RegExp]> = [
      ['registry', /\bregistry\b|registry$/],
      ['repository', /\brepository\b|repository$/],
      ['resolver', /\bresolver\b|resolver$/],
      ['builder', /\bbuilder\b|builder$/],
      ['manager', /\bmanager\b|manager$/],
      ['gateway', /\bgateway\b|gateway$/],
      ['adapter', /\badapter\b|adapter$/],
      ['client', /\bclient\b|client$/],
      ['integration', /\bintegration\b|integration$/],
      ['service', /\bservice\b|service$/],
    ];

    for (const [role, pattern] of rolePatterns) {
      if (symbol.endsWith(role) || pattern.test(identifier)) {
        return { family, primary: role };
      }
    }

    if (['services', 'clients', 'integrations'].includes(family)) {
      return { family, primary: family.slice(0, -1) };
    }

    return { family, primary: 'plain_class' };
  }

  private serviceRolesAreCompatible(
    planned: { family: string; primary: string },
    candidate: { family: string; primary: string },
  ): boolean {
    if (planned.primary === candidate.primary) {
      return true;
    }

    if (planned.primary === 'service' && candidate.family === 'services') {
      return true;
    }

    if (
      planned.family === 'clients'
      && ['client', 'gateway', 'integration', 'adapter'].includes(candidate.primary)
    ) {
      return true;
    }

    if (
      planned.family === 'integrations'
      && ['integration', 'client', 'gateway', 'adapter'].includes(candidate.primary)
    ) {
      return true;
    }

    return false;
  }

  private getSpecMentionedExemplarForPlannedFile(
    file: string,
    kind: string,
    specExistingFiles: string[],
  ): PlannedFileExemplarCandidate | null {
    if (specExistingFiles.length === 0) {
      return null;
    }

    const plannedKind = this.normalizeKindAlias(kind);
    if (!['component', 'inertia_page', 'action', 'composable'].includes(plannedKind)) {
      return null;
    }

    const plannedSegments = this.pathSegmentsForSimilarity(file);
    const scored = specExistingFiles
      .flatMap(existingFile => this.store.getNodesByFile(existingFile))
      .filter(node => !this.isGeneratedPath(node.filePath))
      .map(node => {
        const candidateKind = this.normalizeKindAlias(node.kind);
        if (
          candidateKind !== plannedKind
          && !(plannedKind === 'component' && candidateKind === 'inertia_page')
        ) {
          return null;
        }

        const shapeMatchConfidence = this.shapeMatchConfidenceForPlannedFile(file, plannedKind, node);
        let score = shapeMatchConfidence * 100;
        score += this.sharedPathSegmentCount(plannedSegments, this.pathSegmentsForSimilarity(node.filePath)) * 6;
        if (candidateKind === plannedKind) score += 10;

        return { node, score, shapeMatchConfidence };
      })
      .filter((candidate): candidate is { node: WeaveNode; score: number; shapeMatchConfidence: number } =>
        candidate !== null && candidate.shapeMatchConfidence >= 0.2,
      )
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    const best = scored[0];
    if (!best) {
      return null;
    }

    const base = this.toPlannedFileExemplarCandidate(file, plannedKind, {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: 'Best exemplar among files explicitly co-mentioned by the spec',
    }, 1);
    return {
      ...base,
      reason: `${base.reason}; structural shape confidence is separate from spec co-mention`,
      confidenceReason: 'Spec co-mention explains relevance, but headline confidence is bounded by structural shape match.',
    };
  }

  private getInertiaPageExemplarForPlannedFile(file: string): {
    nodeId: number;
    file: string;
    reason: string;
  } | null {
    const plannedSegments = this.pathSegmentsForSimilarity(file);
    const plannedName = basename(file).toLowerCase();
    const plannedIsAdmin = file.includes('/Admin/');

    const candidates = this.store.getNodesByKind('inertia_page')
      .filter(node => !this.isGeneratedPath(node.filePath))
      .map(node => {
        const candidateIsAdmin = node.filePath.includes('/Admin/');
        let score = this.kindConventionConfidence('inertia_page') * 10;
        if (candidateIsAdmin === plannedIsAdmin) score += 24;
        if (candidateIsAdmin && !plannedIsAdmin) score -= 36;
        if (basename(node.filePath).toLowerCase() === plannedName) score += 20;
        score += this.sharedPathSegmentCount(plannedSegments, this.pathSegmentsForSimilarity(node.filePath)) * 6;
        return { node, score };
      })
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    const best = candidates[0];
    if (!best) {
      return null;
    }

    return {
      nodeId: best.node.id,
      file: best.node.filePath,
      reason: 'Best inertia page exemplar by route/page path similarity',
    };
  }

  private pathSegmentsForSimilarity(filePath: string): string[] {
    return filePath
      .replace(/\.[^.]+$/, '')
      .split(/[\\/_.-]+/)
      .flatMap(segment => segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/))
      .map(segment => this.normalizeTaskTerm(segment.toLowerCase()))
      .filter(segment => segment.length >= 3)
      .filter(segment => !['resources', 'app', 'js', 'pages', 'components', 'actions'].includes(segment));
  }

  private sharedPathSegmentCount(a: string[], b: string[]): number {
    const bSet = new Set(b);
    return Array.from(new Set(a)).filter(segment => bSet.has(segment)).length;
  }

  private contextualBareSpecReferences(
    suspiciousReferences: string[],
    projectReferences: string[],
  ): Set<string> {
    const contextualBasenames = new Set(
      projectReferences
        .filter(reference => reference.includes('/'))
        .map(reference => basename(reference)),
    );
    const hasConfigTreeReferences = projectReferences.some(reference =>
      /^config\/.+\.php$/.test(reference),
    );

    return new Set(
      suspiciousReferences.filter(reference =>
        !reference.includes('/')
        && (
          contextualBasenames.has(basename(reference))
          || (hasConfigTreeReferences && reference !== 'index.php' && /^[a-z0-9_-]+\.php$/.test(reference))
        ),
      ),
    );
  }

  private resolveSpecInput(specInput: string): { file: string; content: string } {
    const file = this.toRelativePath(specInput);
    const content = this.readProjectTextFile(file);
    if (content !== null) {
      return { file, content };
    }

    if (this.looksLikeInlineMarkdownSpec(specInput)) {
      return { file: '<inline-spec>', content: specInput };
    }

    throw new Error(`Spec file not found: ${file}`);
  }

  private inferSpecInputFromBootstrapQuery(query: BootstrapQuery): string | null {
    if (query.start && this.isMarkdownSpecPath(query.start) && this.readProjectTextFile(this.toRelativePath(query.start)) !== null) {
      return query.start;
    }

    return this.firstMentionedMarkdownSpecPath(query.task);
  }

  private firstMentionedMarkdownSpecPath(text: string): string | null {
    for (const match of text.matchAll(/(?:`|^|[\s=:(])([A-Za-z0-9_./@-]+\.md)(?:`|[\s),.;:]|$)/g)) {
      const raw = match[1];
      if (!raw) {
        continue;
      }
      const normalized = this.toRelativePath(raw);
      if (this.isMarkdownSpecPath(normalized) && this.readProjectTextFile(normalized) !== null) {
        return normalized;
      }
    }

    return null;
  }

  private isMarkdownSpecPath(filePath: string): boolean {
    return /\.md$/i.test(filePath);
  }

  private looksLikeInlineMarkdownSpec(value: string): boolean {
    return value.includes('\n')
      || value.trimStart().startsWith('#')
      || value.includes('| ---')
      || value.includes('```')
      || /`[^`]+\.(?:php|vue|js|ts|tsx|jsx|py|md|css|scss|json|yaml|yml|sql)(?::\d+(?:-\d+)?)?`/.test(value);
  }

  private extractSpecReferences(
    content: string,
    specFile: string,
  ): { files: string[]; lineReferences: BootstrapSpecLineReference[] } {
    const references = new Set<string>();
    const lineReferences: BootstrapSpecLineReference[] = [];
    const lineReferenceKeys = new Set<string>();
    const pathPattern = /(^|[`\s|])([A-Za-z0-9_./@-]+\.(?:php|vue|js|ts|tsx|jsx|py|md|css|scss|json|yaml|yml|sql))(?::(\d+)(?:-(\d+))?)?(?=$|[`\s|])/gm;

    for (const treeReference of this.extractMarkdownTreeReferences(content, specFile)) {
      references.add(treeReference);
    }

    for (const match of content.matchAll(pathPattern)) {
      const rawReference = match[2]?.trim();
      if (!rawReference || rawReference.startsWith('http')) {
        continue;
      }

      const normalized = this.normalizeSpecFileReference(rawReference, specFile);
      if (normalized) {
        references.add(normalized);
        const lineStart = match[3] ? Number(match[3]) : null;
        if (lineStart !== null) {
          const lineEnd = match[4] ? Number(match[4]) : undefined;
          const key = `${normalized}:${lineStart}:${lineEnd ?? ''}`;
          if (!lineReferenceKeys.has(key)) {
            lineReferenceKeys.add(key);
            lineReferences.push({
              file: normalized,
              lineStart,
              ...(lineEnd ? { lineEnd } : {}),
            });
          }
        }
      }
    }

    return { files: Array.from(references), lineReferences };
  }

  private extractMarkdownTreeReferences(content: string, specFile: string): string[] {
    const references = new Set<string>();
    const stack: string[][] = [];
    let inFence = false;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        inFence = !inFence;
        continue;
      }

      const treeItem = this.parseMarkdownTreeItem(line, inFence);
      if (!treeItem) {
        if (!inFence && trimmed.length === 0) {
          stack.length = 0;
        }
        continue;
      }

      const segments = treeItem.item
        .replace(/\/$/, '')
        .split('/')
        .filter(Boolean);
      if (segments.length === 0) {
        continue;
      }

      const parent = treeItem.hasBranch
        ? stack[treeItem.depth - 1] ?? []
        : [];
      const fullSegments = treeItem.item.includes('/') && !treeItem.hasBranch
        ? segments
        : [...parent, ...segments];
      const fullPath = fullSegments.join('/');

      if (treeItem.item.endsWith('/')) {
        stack[treeItem.depth] = fullSegments;
        stack.length = treeItem.depth + 1;
        continue;
      }

      if (!this.isSupportedSpecPath(fullPath)) {
        continue;
      }

      const normalized = this.normalizeSpecFileReference(fullPath, specFile);
      if (normalized) {
        references.add(normalized);
      }
    }

    return Array.from(references);
  }

  private dedupeDefaultInferredSpecReferences(files: string[]): string[] {
    const byBasename = new Map<string, string[]>();
    for (const file of files) {
      const entries = byBasename.get(basename(file)) ?? [];
      entries.push(file);
      byBasename.set(basename(file), entries);
    }

    return files.filter(file => {
      const alternatives = byBasename.get(basename(file)) ?? [];
      if (alternatives.length <= 1) {
        return true;
      }
      if (!this.isDefaultInferredBareSpecPath(file)) {
        return true;
      }
      return !alternatives.some(alternative =>
        alternative !== file && alternative.split('/').length > file.split('/').length,
      );
    });
  }

  private isDefaultInferredBareSpecPath(file: string): boolean {
    return /^resources\/js\/Components\/[^/]+\.(?:vue|js|ts)$/.test(file)
      || /^resources\/js\/composables\/[^/]+\.(?:js|ts)$/.test(file)
      || /^app\/Actions\/[^/]+Action\.php$/.test(file)
      || /^app\/Models\/[^/]+\.php$/.test(file);
  }

  private parseMarkdownTreeItem(line: string, inFence = false): {
    item: string;
    depth: number;
    hasBranch: boolean;
  } | null {
    const match = line.match(/([A-Za-z0-9_./@-]+(?:\.(?:php|vue|js|ts|tsx|jsx|py|md|css|scss|json|yaml|yml|sql)|\/))\s*$/);
    if (!match || !match[1]) {
      return null;
    }

    const item = match[1];
    const prefix = line.slice(0, line.lastIndexOf(item));
    const hasBullet = inFence && /(?:^|\s)[-*+]\s*$/.test(prefix);
    const hasBranch = hasBullet
      || /[├└+]/.test(prefix)
      || /(?:^|\s)[|`\\-]*[-─]{2,}\s*$/.test(prefix);
    if (!hasBranch && !item.endsWith('/')) {
      return null;
    }

    const indentDepth = (prefix.match(/(?:│|\|)? {2,4}/g) ?? []).length;
    const branchDepth = hasBranch ? 1 : 0;

    return {
      item,
      depth: indentDepth + branchDepth,
      hasBranch,
    };
  }

  private isSupportedSpecPath(path: string): boolean {
    return /\.(?:php|vue|js|ts|tsx|jsx|py|md|css|scss|json|yaml|yml|sql)$/i.test(path);
  }

  private normalizeSpecFileReference(reference: string, specFile: string): string | null {
    const referenceWithoutLineRange = reference.replace(/:\d+(?:-\d+)?$/, '');
    if (this.looksLikeLibraryToken(referenceWithoutLineRange)) {
      return null;
    }

    const normalized = referenceWithoutLineRange
      .replace(/^\.\/+/, '')
      .replace(/^@\//, 'resources/js/');

    if (existsSync(join(this.projectRoot, normalized))) {
      return normalized;
    }

    const relativeToSpec = join(dirname(specFile), normalized).replace(/\\/g, '/');
    if (existsSync(join(this.projectRoot, relativeToSpec))) {
      return relativeToSpec;
    }

    const basenameMatch = this.resolveBareSpecFileReference(normalized);
    if (basenameMatch) {
      return basenameMatch;
    }

    return this.inferProjectPathForSpecReference(normalized);
  }

  private resolveBareSpecFileReference(reference: string): string | null {
    if (reference.includes('/')) {
      return null;
    }
    if (this.isAmbiguousBareSpecFilename(reference)) {
      return null;
    }

    const matches = this.indexedProjectFiles()
      .filter(file => basename(file) === reference)
      .sort((a, b) => a.length - b.length || a.localeCompare(b));

    return matches[0] ?? null;
  }

  private isAmbiguousBareSpecFilename(reference: string): boolean {
    return /^index\.(?:php|vue|js|ts|tsx|jsx|css|scss|md|json)$/i.test(reference);
  }

  private inferProjectPathForSpecReference(reference: string): string {
    if (reference.startsWith('Pages/')) {
      return `resources/js/${reference}`;
    }
    if (reference.startsWith('Components/')) {
      return `resources/js/${reference}`;
    }
    if (reference.startsWith('composables/')) {
      return `resources/js/${reference}`;
    }
    if (reference.includes('/')) {
      return reference;
    }
    if (reference.endsWith('.vue')) {
      return `resources/js/Components/${reference}`;
    }
    if (reference.match(/^use[A-Z].*\.(?:js|ts)$/)) {
      return `resources/js/composables/${reference}`;
    }
    if (reference.endsWith('.php') && reference.match(/^[A-Z].*Action\.php$/)) {
      return `app/Actions/${reference}`;
    }
    if (reference.endsWith('.php') && reference.match(/^[A-Z].*\.php$/)) {
      return `app/Models/${reference}`;
    }
    return reference;
  }

  private looksLikeLibraryToken(reference: string): boolean {
    if (reference.includes('/')) {
      return false;
    }

    const packageLikeExtensions = ['.js', '.ts', '.css'];
    return packageLikeExtensions.some(extension => reference.endsWith(extension))
      && !existsSync(join(this.projectRoot, reference))
      && !reference.match(/^use[A-Z]/);
  }

  private looksLikeProjectFilePath(reference: string): boolean {
    return reference.includes('/')
      || reference.startsWith('app.')
      || reference.startsWith('use')
      || /^[A-Z]/.test(reference)
      || reference.startsWith('config.')
      || reference.startsWith('database.');
  }

  private findNovelPathPrefixes(files: string[]): string[] {
    const prefixes = new Set<string>();
    for (const file of files) {
      const prefix = this.firstMissingPathPrefix(file);
      if (prefix) {
        prefixes.add(prefix);
      }
    }
    return Array.from(prefixes).sort();
  }

  private firstMissingPathPrefix(file: string): string | null {
    const parts = file.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (!existsSync(join(this.projectRoot, prefix))) {
        return prefix;
      }
    }
    return null;
  }

  private inferSpecEntryCandidates(
    specContext: BootstrapSpecContext,
    maxCandidates: number,
  ): BootstrapEntryCandidate[] {
    const candidates: BootstrapEntryCandidate[] = [];
    const lineReferenceCounts = new Map<string, number>();
    for (const reference of specContext.lineReferences ?? []) {
      lineReferenceCounts.set(reference.file, (lineReferenceCounts.get(reference.file) ?? 0) + 1);
    }
    const scoredFiles = [...specContext.existingFiles]
      .sort((a, b) =>
        (lineReferenceCounts.get(b) ?? 0) - (lineReferenceCounts.get(a) ?? 0)
        || this.specEntryKindWeight(b) - this.specEntryKindWeight(a)
        || a.localeCompare(b),
      );

    for (const file of scoredFiles.slice(0, maxCandidates)) {
      const lineReferences = lineReferenceCounts.get(file) ?? 0;
      candidates.push({
        file,
        confidence: lineReferences > 0 ? 0.99 : 0.94,
        reasons: [
          lineReferences > 0
            ? `listed in spec ${specContext.file} with line reference`
            : `listed in spec ${specContext.file}`,
        ],
      });
    }

    if (candidates.length < maxCandidates) {
      candidates.push({
        file: specContext.file,
        confidence: 0.94,
        reasons: ['provided spec document'],
      });
    }

    return candidates.slice(0, maxCandidates);
  }

  private specEntryKindWeight(file: string): number {
    const kind = this.inferKindForPath(file);
    switch (kind) {
      case 'inertia_page':
        return 90;
      case 'composable':
        return 86;
      case 'action':
        return 82;
      case 'test':
        return 81;
      case 'service':
        return 81;
      case 'config_array':
        return 80;
      case 'component':
        return 76;
      default:
        return 50;
    }
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
      .filter(node => !this.isBootstrapNoisePath(node.filePath))
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
	      const searchTokens = this.searchTokensForText(`${node.filePath} ${node.symbolName}`);
	      for (const term of this.rankableTaskTerms(terms)) {
	        if (searchTokens.has(term)) {
	          entry.matchedTerms.add(term);
	        }
	      }
      fileScores.set(node.filePath, entry);
    }

    const scored = Array.from(fileScores.entries())
      .sort((a, b) => this.entryCandidateScore(b[1]) - this.entryCandidateScore(a[1]) || a[0].localeCompare(b[0]));

    if (scored.length === 0) {
      const fallback = this.fallbackEntryCandidates(maxCandidates);
      return profile.creationLike
        ? fallback.map(candidate => ({
            ...candidate,
            confidence: 0.35,
            reasons: ['weak fallback: no strong graph evidence for dominant task terms'],
          }))
        : fallback;
    }

    if (this.shouldUseWeakBootstrapFallback(profile, scored)) {
      return this.fallbackEntryCandidates(maxCandidates)
        .map(candidate => ({
          ...candidate,
          confidence: 0.35,
          reasons: ['weak fallback: no strong graph evidence for dominant task terms'],
        }));
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

  private hasWeakBootstrapEvidence(candidates: BootstrapEntryCandidate[]): boolean {
    return candidates.length > 0
      && candidates.every(candidate =>
        candidate.reasons.some(reason => reason.startsWith('weak fallback:')),
      );
  }

  private entryCandidateScore(entry: {
    bestScore: number;
    matchedTerms: Set<string>;
    reasons: Set<string>;
  } | undefined): number {
    if (!entry) {
      return 0;
    }

    const strongMatches = Array.from(entry.matchedTerms)
      .filter(term => !this.isLowSignalTaskTerm(term));
    const lowSignalOnlyPenalty = entry.matchedTerms.size > 0 && strongMatches.length === 0 ? 10 : 0;

    return entry.bestScore
      + Math.min(12, strongMatches.length * 4)
      + Math.min(3, (entry.matchedTerms.size - strongMatches.length))
      + Math.min(3, entry.reasons.size)
      - lowSignalOnlyPenalty;
  }

  private shouldUseWeakBootstrapFallback(
    profile: TaskProfile,
    scored: Array<[string, { matchedTerms: Set<string> }]>,
  ): boolean {
    if (!profile.creationLike || profile.mode !== 'implementation') {
      return false;
    }
    if (profile.endpointLiterals.length > 0 || profile.specContext) {
      return false;
    }

    const dominantTerms = this.significantTaskTerms(profile.terms).slice(0, 3);
    if (dominantTerms.length === 0) {
      return false;
    }

    return !scored.some(([_file, entry]) =>
      dominantTerms.some(term => entry.matchedTerms.has(term)),
    );
  }

  private extractTaskTerms(task: string): string[] {
    const stopwords = new Set([
      'a', 'an', 'and', 'the', 'to', 'for', 'of', 'in', 'on', 'with', 'without',
      'from', 'into', 'by', 'or', 'if', 'is', 'it', 'this', 'that', 'add', 'update',
      'change', 'fix', 'make', 'use', 'new', 'existing', 'line', 'text', 'copy',
      'short', 'small', 'real', 'task', 'build', 'create', 'implement', 'scaffold',
      'wire', 'wiring', 'feature', 'features', 'composable', 'composables', 'action', 'actions', 'route',
      'routes', 'api', 'endpoint', 'endpoints',
      'doc', 'docs', 'section', 'reference', 'possible', 'maybe', 'note',
      'another', 'other', 'others', 'their', 'them', 'then', 'there', 'these',
      'those', 'thing', 'things', 'which', 'while',
	    ]);

    return this.stripEndpointLiterals(task)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(term => term.trim())
      .map(term => this.normalizeTaskTerm(term))
      .filter(term => term.length >= 3)
      .filter(term => !stopwords.has(term));
  }

  private normalizeTaskTerm(term: string): string {
    if (term.length > 4 && term.endsWith('ies')) {
      return `${term.slice(0, -3)}y`;
    }
    if (term.length > 5 && term.endsWith('ing')) {
      return term.slice(0, -3);
    }
    if (term.length > 4 && term.endsWith('ed')) {
      return term.slice(0, -2);
    }
    if (term.length > 4 && term.endsWith('s')) {
      return term.slice(0, -1);
    }
    return term;
  }

  private rankableTaskTerms(terms: string[]): string[] {
    return Array.from(new Set(
      terms
        .map(term => this.normalizeTaskTerm(term.toLowerCase()))
        .filter(term => term.length >= 4)
        .filter(term => !this.isLowSignalTaskTerm(term)),
    ));
  }

  private searchTokensForText(value: string): Set<string> {
    return new Set(
      value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map(term => this.normalizeTaskTerm(term.trim()))
        .filter(term => term.length >= 3),
    );
  }

  private textMatchesAnyRankableTerm(value: string, terms: string[]): boolean {
    const tokens = this.searchTokensForText(value);
    return this.rankableTaskTerms(terms).some(term => tokens.has(term));
  }

  private fileBasenameMatchesTerm(filePath: string, term: string): boolean {
    const base = basename(filePath)
      .replace(/\.[^.]+$/, '');
    return this.searchTokensForText(base).has(term);
  }

  private taskPrefersTests(terms: string[]): boolean {
    return terms.some(term => ['test', 'tests', 'spec', 'specs', 'coverage', 'assert'].includes(term));
  }

  private inferTaskMode(task: string, prefersTests: boolean): TaskMode {
    if (prefersTests) {
      return 'implementation';
    }

    const lowerTask = this.stripEndpointLiterals(task).toLowerCase();
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
    if (mode === 'audit_communication') {
      [
        'client',
        'clients',
        'service',
        'services',
        'integration',
        'integrations',
        'event',
        'events',
        'stream',
        'streaming',
        'sse',
        'socket',
        'sockets',
        'websocket',
        'websockets',
        'poll',
        'polling',
        'keepalive',
        'transport',
        'http',
        'network',
        'request',
        'requests',
        'response',
        'responses',
        'endpoint',
        'endpoints',
        'route',
        'routes',
        'status',
        'api',
      ].forEach(term => expanded.add(term));
    }

    return Array.from(expanded);
  }

  private buildTaskProfile(
    task: string,
    specContext: BootstrapSpecContext | null = null,
  ): TaskProfile {
    const baseTerms = this.extractTaskTerms(task);
    const prefersTests = this.taskPrefersTests(baseTerms);
    const mode = this.inferTaskMode(task, prefersTests);
    const endpointLiterals = this.extractEndpointLiterals(task);
    const expandedTerms = this.expandTaskTerms(baseTerms, task, mode);
    const terms = endpointLiterals.length > 0
      ? Array.from(new Set([...expandedTerms, 'http', 'network']))
      : expandedTerms;
    const lowerTask = this.stripEndpointLiterals(task).toLowerCase();
    return {
      mode,
      focus: mode === 'audit_communication' ? 'mixed' : this.inferTaskFocus(task, prefersTests),
      prefersTests,
      terms,
      endpointLiterals,
      specContext,
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

    const lowerTask = this.stripEndpointLiterals(task).toLowerCase();
    const frontendTerms = [
      'page', 'component', 'copy', 'text', 'message', 'label', 'button', 'modal',
      'layout', 'form', 'input', 'header', 'footer', 'tooltip', 'dropdown',
      'screen', 'view', 'ui', 'composable', 'resolver',
      'debug', 'panel', 'overlay', 'slider', 'toggle', 'frontend',
      'dispatcher', 'browser', 'vue', 'javascript',
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
    const fileTokens = this.searchTokensForText(node.filePath);
    const symbolTokens = this.searchTokensForText(node.symbolName);
    const rankableTerms = this.rankableTaskTerms(terms);
    const matchedTerms = rankableTerms.filter(term =>
      fileTokens.has(term) || symbolTokens.has(term),
    );
    if (taskMode === 'implementation' && matchedTerms.length === 0) {
      return 0;
    }

    let score = this.bundleKindPriority(node.kind) * 0.05
      + this.pathBootstrapWeight(file, prefersTests, taskFocus, taskMode, terms)
      + Math.min(24, matchedTerms.length * 6);

    for (const term of matchedTerms) {
      if (fileTokens.has(term)) score += 6;
      if (symbolTokens.has(term)) score += 5;
      if (this.fileBasenameMatchesTerm(file, term)) {
        score += 4;
      }
    }

    if (this.isLowValuePrecedent(file, terms)) {
      score -= 18;
    }

    if (node.kind === 'action' && matchedTerms.length > 0) {
      score += 4;
    }
    if (node.kind === 'inertia_page' && matchedTerms.length > 0) {
      score += 4;
    }
    if (node.kind === 'component' && matchedTerms.length > 0) {
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
    if (taskFocus === 'frontend' && filePath.startsWith('app/Actions/')) {
      const pathTokens = this.searchTokensForText(filePath);
      const hasSpecificTaskTerm = this.rankableTaskTerms(terms).some(term => pathTokens.has(term));
      if (!hasSpecificTaskTerm) {
        score -= 10;
      }
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
      score += this.communicationPathWeight(filePath, terms);
      if (filePath.includes('/Admin/') && !terms.includes('admin')) score -= 24;
      if (this.isBrowseSurfacePath(filePath) && !wantsBrowseSurfaces) score -= 36;
    }
    return score;
  }

  private nodeReasonForTask(node: WeaveNode, terms: string[]): string | null {
    const fileTokens = this.searchTokensForText(node.filePath);
    const symbolTokens = this.searchTokensForText(node.symbolName);
    for (const term of this.rankableTaskTerms(terms)) {
      if (fileTokens.has(term)) {
        return `task term "${term}" matches file path`;
      }
      if (symbolTokens.has(term)) {
        return `task term "${term}" matches symbol`;
      }
    }
    return `preferred ${node.kind} candidate`;
  }

  private fallbackEntryCandidates(maxCandidates: number): BootstrapEntryCandidate[] {
    const candidates: BootstrapEntryCandidate[] = [];
    const seenFiles = new Set<string>();

    for (const kind of ['action', 'inertia_page', 'model', 'migration', 'form_request', 'test', 'component', 'method', 'spec']) {
      const nodes = this.store.getNodesByKind(kind)
        .filter(node => !this.isGeneratedPath(node.filePath))
        .filter(node => !this.isBootstrapNoisePath(node.filePath))
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

    if (taskProfile.specContext) {
      for (const candidate of this.inferSpecEntryCandidates(taskProfile.specContext, maxCandidates)) {
        add(candidate);
      }
    }

    const inferred = this.inferEntryCandidates(query.task, maxCandidates, taskProfile);
    for (const candidate of inferred) {
      add(candidate);
    }

    const endpointCandidates = this.inferEndpointLiteralCandidates(taskProfile, maxCandidates);
    for (const candidate of endpointCandidates) {
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
      .sort((a, b) =>
        this.bootstrapCandidateSortScore(b, taskProfile) - this.bootstrapCandidateSortScore(a, taskProfile)
        || a.file.localeCompare(b.file),
      )
      .slice(0, maxCandidates * 2);

    return this.filterBootstrapEntryCandidates(candidates, query, taskProfile)
      .slice(0, maxCandidates);
  }

  private filterBootstrapEntryCandidates(
    candidates: BootstrapEntryCandidate[],
    query: BootstrapQuery,
    taskProfile: TaskProfile,
  ): BootstrapEntryCandidate[] {
    const noiseFiltered = query.start
      ? candidates
      : candidates.filter(candidate => !this.isBootstrapNoisePath(candidate.file));
    const frontendFiltered = this.filterFrontendImplementationCandidates(noiseFiltered, query, taskProfile);

    if (taskProfile.mode !== 'audit_communication' || taskProfile.terms.includes('admin')) {
      return this.filterBrowseEntryCandidates(frontendFiltered, query, taskProfile);
    }

    const providedStart = query.start ? this.toRelativePath(query.start) : null;
    const preferred = frontendFiltered.filter(candidate =>
      candidate.file === providedStart || !candidate.file.includes('/Admin/'),
    );

    return this.filterBrowseEntryCandidates(preferred.length > 0 ? preferred : frontendFiltered, query, taskProfile);
  }

  private bootstrapCandidateSortScore(
    candidate: BootstrapEntryCandidate,
    taskProfile: TaskProfile,
  ): number {
    let score = candidate.confidence * 100;
    score += this.fileTermMatchScore(candidate.file, this.significantTaskTerms(taskProfile.terms)) * 2;
    if (candidate.reasons.some(reason => reason.startsWith('task term '))) {
      score += 12;
    }
    if (candidate.reasons.some(reason => reason.startsWith('weak fallback:'))) {
      score -= 80;
    }
    if (candidate.reasons.some(reason => reason.startsWith('provided') || reason.startsWith('listed in spec'))) {
      score += 20;
    }
    if (candidate.reasons.some(reason => reason.includes('with line reference'))) {
      score += 60;
    }
    if (candidate.reasons.some(reason => reason === 'provided spec document')) {
      score -= 30;
    }
    return score;
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
      const source = this.readProjectTextFile(file);
      let score = this.communicationPathWeight(file, taskProfile?.terms ?? [])
        + this.communicationSourceWeight(source ?? '');

      if (taskProfile) {
        score += this.fileTermMatchScore(file, this.significantTaskTerms(taskProfile.terms));
      }
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

  private communicationPathWeight(filePath: string, terms: string[]): number {
    const lower = filePath.toLowerCase();
    let score = 0;

    if (this.isServiceClientPath(lower)) score += 18;
    if (this.isApiRoutePath(lower)) score += 14;
    if (this.isHttpHelperPath(lower)) score += 16;
    if (this.isCommunicationFrontendPath(lower)) score += 14;
    if (this.isCommunicationBackendPath(lower)) score += 12;
    if (lower.startsWith('config/')) score += this.pathHasCommunicationKeyword(lower) ? 10 : 4;
    if (lower.startsWith('app/providers/') || lower.startsWith('src/providers/')) score += 8;

    const termScore = this.fileTermMatchScore(filePath, this.significantTaskTerms(terms));
    if (termScore > 0) {
      score += Math.min(18, termScore);
    }

    return score;
  }

  private communicationSourceWeight(source: string): number {
    if (!source) {
      return 0;
    }

    let score = 0;
    if (/\b(?:fetch|axios|postWithKeepalive|EventSource|WebSocket|XMLHttpRequest)\b/.test(source)) score += 18;
    if (/\brouter\.(?:get|post|put|patch|delete|visit)\b/.test(source)) score += 12;
    if (/\bRoute::(?:get|post|put|patch|delete|apiResource|resource)\b/.test(source)) score += 12;
    if (/\b(?:Http::|GuzzleHttp|curl_exec)\b/.test(source)) score += 12;
    if (/\b(?:stream|poll|subscribe|publish|emit|listen|socket|keepalive)\b/i.test(source)) score += 10;
    return score;
  }

  private isServiceClientPath(lowerPath: string): boolean {
    return /^(?:app|src)\/(?:clients|services|integrations|gateways|adapters)\//.test(lowerPath)
      || /\/(?:clients|services|integrations|gateways|adapters)\//.test(lowerPath);
  }

  private isApiRoutePath(lowerPath: string): boolean {
    return lowerPath === 'routes/api.php'
      || lowerPath.startsWith('routes/')
      || /(?:^|\/)(?:api|routes?)\.(?:php|js|ts)$/.test(lowerPath);
  }

  private isHttpHelperPath(lowerPath: string): boolean {
    return /(?:^|\/)(?:api|http|client|request|transport|keepalive)\.(?:js|ts|php)$/.test(lowerPath)
      || /\/(?:api|http|network|transport)\//.test(lowerPath);
  }

  private isCommunicationFrontendPath(lowerPath: string): boolean {
    return lowerPath.startsWith('resources/js/')
      && this.pathHasCommunicationKeyword(lowerPath);
  }

  private isCommunicationBackendPath(lowerPath: string): boolean {
    return /^(?:app|src)\/(?:actions|controllers|jobs|listeners|events|commands)\//.test(lowerPath)
      && this.pathHasCommunicationKeyword(lowerPath);
  }

  private pathHasCommunicationKeyword(lowerPath: string): boolean {
    return /(?:event|stream|socket|websocket|sse|poll|transport|client|api|http|request|response|sync|channel|keepalive|subscribe|publish)/.test(lowerPath);
  }

  private isBrowseSurfacePath(filePath: string): boolean {
    return /\/(?:List|Index|Browse|History)[^/]*\.(?:php|vue|ts|js)$/i.test(filePath);
  }

  private isPatternPeerFile(filePath: string): boolean {
    return /(Preset|Presets|Resolver|Manifest|Mapper|Engine)\.(?:js|ts|vue)$/i.test(filePath);
  }

  private isLowSignalTaskTerm(term: string): boolean {
    return [
      'action',
      'actions',
      'another',
      'route',
      'routes',
      'api',
      'endpoint',
      'endpoints',
      'test',
      'tests',
      'control',
      'controls',
      'roll',
      'feature',
      'features',
      'user',
      'users',
      'member',
      'members',
      'scoped',
      'component',
      'components',
      'page',
      'pages',
      'doc',
      'docs',
      'section',
      'reference',
      'possible',
      'maybe',
      'note',
      'other',
      'others',
      'their',
      'them',
      'then',
      'there',
      'these',
      'those',
      'thing',
      'things',
      'which',
      'while',
	    ].includes(term);
	  }

  private significantTaskTerms(terms: string[]): string[] {
    const filtered = terms.filter(term => !this.isLowSignalTaskTerm(term));
    return filtered.length > 0 ? filtered : terms;
  }

  private inferEndpointLiteralCandidates(
    taskProfile: TaskProfile,
    maxCandidates: number,
  ): BootstrapEntryCandidate[] {
    const scored = this.scoreEndpointLiteralFiles(taskProfile);
    if (scored.length === 0) {
      return [];
    }

    const maxScore = scored[0]?.score ?? 1;
    return scored
      .slice(0, maxCandidates)
      .map(candidate => ({
        file: candidate.file,
        confidence: Math.max(0.68, Math.min(0.97, candidate.score / maxScore)),
        reasons: Array.from(candidate.reasons).slice(0, 3),
      }));
  }

  private scoreEndpointLiteralFiles(taskProfile: TaskProfile): Array<{
    file: string;
    score: number;
    reasons: Set<string>;
  }> {
    if (taskProfile.endpointLiterals.length === 0) {
      return [];
    }

    const files = this.indexedProjectFiles()
      .filter(file => !this.isGeneratedPath(file))
      .filter(file => taskProfile.prefersTests || !file.startsWith('tests/'))
      .filter(file => this.isEndpointSearchableFile(file));

    const scored: Array<{ file: string; score: number; reasons: Set<string> }> = [];
    for (const file of files) {
      const source = this.readProjectTextFile(file);
      if (!source) {
        continue;
      }

      const result = this.scoreFileForEndpointLiterals(file, source, taskProfile);
      if (result.score > 0) {
        scored.push({ file, ...result });
      }
    }

    return scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  }

  private scoreFileForEndpointLiterals(
    file: string,
    source: string,
    taskProfile: TaskProfile,
  ): { score: number; reasons: Set<string> } {
    const lowerFile = file.toLowerCase();
    const lowerSource = source.toLowerCase();
    const searchable = `${lowerFile}\n${lowerSource}`;
    const endpointCarrier = this.isEndpointCarrierFile(file, source);
    const reasons = new Set<string>();
    let score = 0;

    for (const literal of taskProfile.endpointLiterals) {
      const lowerLiteral = literal.toLowerCase();
      const segments = this.endpointSegments(literal);
      if (segments.length === 0) {
        continue;
      }

      const exactMatch = lowerSource.includes(lowerLiteral);
      const matchedSegments = segments.filter(segment =>
        this.endpointSegmentMatches(searchable, endpointCarrier, segment),
      );
      const allSegmentsMatched = matchedSegments.length === segments.length;

      if (exactMatch) {
        score += 70;
        reasons.add(`contains endpoint literal ${literal}`);
      } else if (allSegmentsMatched) {
        score += endpointCarrier ? 55 : 30;
        reasons.add(`matches endpoint path segments for ${literal}`);
      } else if (matchedSegments.length >= Math.min(2, segments.length)) {
        score += endpointCarrier ? 24 : 12;
        reasons.add(`partially matches endpoint path segments for ${literal}`);
      }
    }

    if (score <= 0) {
      return { score: 0, reasons };
    }

    if (this.isFrontendFile(file)) {
      score += 24;
      reasons.add('frontend endpoint caller candidate');
    }
    if (file.startsWith('resources/js/composables/')) {
      score += 18;
      reasons.add('frontend composable endpoint surface');
    }
    if (file.startsWith('resources/js/Pages/')) {
      score += 10;
    }
    if (file === 'routes/api.php' || file === 'routes/web.php') {
      score += 22;
      reasons.add('route table defines endpoint paths');
    }
    if (/\b(postWithKeepalive|fetch|axios|router\.(?:get|post|put|patch|delete)|api\.)\b/.test(source)) {
      score += this.isFrontendFile(file) ? 18 : 8;
      reasons.add('contains HTTP client call surface');
    }
    if (/\bACTION_PATHS\b/.test(source) || /\b(?:move|attack|cast|end_turn|death_save)\s*:/.test(source)) {
      score += 16;
      reasons.add('contains endpoint action dispatcher map');
    }
    if (lowerFile.startsWith('app/actions/') && !taskProfile.terms.some(term => lowerFile.includes(term))) {
      score -= 18;
    }
    if (this.isBrowseSurfacePath(file)) {
      score -= 24;
    }

    return { score, reasons };
  }

  private extractEndpointLiterals(task: string): string[] {
    const endpoints = new Set<string>();
    const pattern = /(^|[\s`'"])(\/[A-Za-z0-9_$:{}./-]+)/g;
    for (const match of task.matchAll(pattern)) {
      const endpoint = this.normalizeEndpointLiteral(match[2] ?? '');
      if (endpoint) {
        endpoints.add(endpoint);
      }
    }
    return Array.from(endpoints);
  }

  private stripEndpointLiterals(task: string): string {
    return task.replace(/(^|[\s`'"])(\/[A-Za-z0-9_$:{}./-]+)/g, '$1 ');
  }

  private normalizeEndpointLiteral(value: string): string | null {
    const endpoint = value
      .trim()
      .replace(/[),.;:]+$/g, '')
      .replace(/\/+$/g, '');

    if (!endpoint.startsWith('/') || endpoint.startsWith('//')) {
      return null;
    }
    if (!/[a-z]/i.test(endpoint) || endpoint.split('/').filter(Boolean).length === 0) {
      return null;
    }

    return endpoint;
  }

  private endpointSegments(endpoint: string): string[] {
    const ignored = new Set(['api', 'dev', 'v1', 'v2']);
    return endpoint
      .toLowerCase()
      .split('/')
      .map(segment => segment.trim())
      .filter(Boolean)
      .filter(segment => !ignored.has(segment))
      .filter(segment => !/^\{[^}]+\}$/.test(segment))
      .filter(segment => !/^\$\{[^}]+\}$/.test(segment))
      .filter(segment => !/^:[a-z0-9_]+$/.test(segment))
      .map(segment => segment.replace(/[^a-z0-9_-]/g, ''))
      .filter(segment => segment.length >= 2);
  }

  private indexedProjectFiles(): string[] {
    const cachedFiles = this.store.getAllFileCache().map(entry => this.toRelativePath(entry.filePath));
    if (cachedFiles.length > 0) {
      return Array.from(new Set(cachedFiles));
    }

    return Array.from(new Set(this.store.getAllNodes().map(node => node.filePath)));
  }

  private isEndpointSearchableFile(file: string): boolean {
    return /\.(php|js|ts|vue|tsx|jsx)$/i.test(file)
      && !file.includes('/node_modules/')
      && !file.includes('/vendor/');
  }

  private isEndpointCarrierFile(file: string, source: string): boolean {
    return file.startsWith('routes/')
      || this.isFrontendFile(file)
      || /\b(?:Route::|fetch|axios|postWithKeepalive|router\.(?:get|post|put|patch|delete)|api\.)\b/.test(source);
  }

  private endpointSegmentMatches(
    searchable: string,
    endpointCarrier: boolean,
    segment: string,
  ): boolean {
    if (!endpointCarrier && ['action', 'actions', 'route', 'routes', 'api', 'endpoint', 'endpoints'].includes(segment)) {
      return false;
    }

    return searchable.includes(segment);
  }

  private isFrontendFile(file: string): boolean {
    return file.startsWith('resources/js/');
  }

  private detectScopeMismatch(
    taskProfile: TaskProfile,
    workingSet: ContextFile[],
  ): {
    expectedFocus: 'frontend' | 'backend' | 'tests';
    actualFocus: 'frontend' | 'backend' | 'tests' | 'mixed' | 'unknown';
    reason: string;
  } | null {
    if (taskProfile.focus === 'mixed') {
      return null;
    }

    const actualFocus = this.inferWorkingSetFocus(workingSet);
    if (actualFocus === 'unknown' || actualFocus === 'mixed' || actualFocus === taskProfile.focus) {
      return null;
    }

    return {
      expectedFocus: taskProfile.focus,
      actualFocus,
      reason: `Task appears ${taskProfile.focus}-focused, but the working set is ${actualFocus}-focused. Widen narrowly or rerun bootstrap with an explicit scope hint before editing.`,
    };
  }

  private buildBootstrapWarnings(
    taskProfile: TaskProfile,
    workingSet: ContextFile[],
  ): BootstrapWarning[] {
    const warnings: BootstrapWarning[] = [];
    const specContext = taskProfile.specContext;

    if (specContext?.novelPathPrefixes.length) {
      warnings.push({
        code: 'novel_path_prefixes',
        message: 'Spec references files under path prefixes not currently present in the project.',
        files: specContext.novelPathPrefixes,
      });
    }

    if (specContext?.suspiciousReferences.length) {
      warnings.push({
        code: 'suspicious_spec_references',
        message: 'Some spec references looked like libraries or unresolved bare filenames rather than project paths.',
        files: specContext.suspiciousReferences,
      });
    }

    const plannedEvidenceGaps = specContext ? this.plannedFileEvidenceGaps(specContext) : [];
    if (plannedEvidenceGaps.length > 0) {
      warnings.push({
        code: 'planned_file_evidence_gaps',
        message: 'Some planned files have weak or missing indexed evidence; treat these as invention zones and verify manually instead of assuming Weave knows the pattern.',
        files: plannedEvidenceGaps.map(gap => gap.file),
        details: {
          gaps: plannedEvidenceGaps,
        },
      });
    }

    const unmatchedTaskTerms = this.unmatchedTaskTermsForSpec(taskProfile);
    if (unmatchedTaskTerms.length > 0) {
      warnings.push({
        code: 'spec_task_term_mismatch',
        message: 'The task contains important terms that do not appear in the spec; verify whether the prompt and spec describe the same work before editing.',
        terms: unmatchedTaskTerms,
      });
    }

    const projectTestInstructionFiles = this.projectInstructionFilesMentioningTests();
    if (
      specContext
      && !specContext.mentionsTests
      && taskProfile.creationLike
      && projectTestInstructionFiles.length > 0
    ) {
      warnings.push({
        code: 'project_test_guidance',
        message: 'Project instructions mention tests even though the spec does not; do not treat mentionsTests:false as permission to skip validation or test changes.',
        files: projectTestInstructionFiles,
      });
    }

    const highFanoutFiles = workingSet
      .filter(file => this.isHighFanoutFile(file.file))
      .map(file => file.file);
    if (highFanoutFiles.length > 0) {
      warnings.push({
        code: 'high_fanout_entry',
        message: 'Some working-set files have many graph relationships; their neighbors may be noisy. Prefer spec-listed files or narrower query targets for localized edits.',
        files: highFanoutFiles,
      });
    }

    const diagnostics = this.getDiagnosticsSnapshot();
    const issueCount = diagnostics.totals.issues;
    if (issueCount > 0) {
      warnings.push({
        code: 'indexing_diagnostics_issues',
        message: 'The index has unresolved extraction issues; use internalIssues vs externalIssues to decide whether missing edges are likely project gaps or external dependency noise.',
        details: {
          issueCount,
          queryErrors: diagnostics.totals.queryErrors,
          l2EdgesSkipped: diagnostics.totals.l2EdgesSkipped,
          l3EdgesSkipped: diagnostics.totals.l3EdgesSkipped,
          externalIssues: diagnostics.totals.externalIssues,
          internalIssues: diagnostics.totals.internalIssues,
          unknownIssues: diagnostics.totals.unknownIssues,
        },
      });
    }

    return warnings;
  }

  private projectInstructionFilesMentioningTests(): string[] {
    const candidates = [
      'AGENTS.md',
      'CLAUDE.md',
      'CONTRIBUTING.md',
      'README.md',
      '.cursor/rules',
      '.github/copilot-instructions.md',
    ];
    return candidates.filter(file => {
      const content = this.readProjectTextFile(file);
      if (!content) {
        return false;
      }
      return /\b(?:tests?|testing|phpunit|pest|vitest|pytest|rspec|jest|coverage)\b/i.test(content);
    });
  }

  private plannedFileEvidenceGaps(specContext: BootstrapSpecContext): Array<{
    file: string;
    kind: string | null;
    issues: string[];
    exemplarFile: string | null;
    confidence: number;
  }> {
    const gaps: Array<{
      file: string;
      kind: string | null;
      issues: string[];
      exemplarFile: string | null;
      confidence: number;
    }> = [];

    for (const exemplar of specContext.likelyNewFileExemplars ?? []) {
      const issues: string[] = [];
      if (!exemplar.kind) {
        issues.push('no kind inferred');
      }
      if (!exemplar.exemplarFile) {
        issues.push(exemplar.reason.startsWith('No reliable exemplar') ? 'no reliable exemplar' : 'no indexed exemplar');
      }
      if (exemplar.kind) {
        const conventions = this.conventionEngine
          .getConventions(this.normalizeKindAlias(exemplar.kind))
          .filter(convention => convention.confidence >= 0.9);
        if (conventions.length === 0) {
          issues.push('no high-confidence conventions');
        }
      }
      if (exemplar.confidence < 0.75) {
        issues.push('low exemplar confidence');
      }

      if (issues.length > 0) {
        gaps.push({
          file: exemplar.file,
          kind: exemplar.kind,
          issues,
          exemplarFile: exemplar.exemplarFile,
          confidence: exemplar.confidence,
        });
      }
    }

    return gaps.slice(0, 12);
  }

  private unmatchedTaskTermsForSpec(taskProfile: TaskProfile): string[] {
    const specContext = taskProfile.specContext;
    if (!specContext) {
      return [];
    }

    const specTerms = new Set([
      ...(specContext.termIndex ?? specContext.terms ?? []),
      ...specContext.referencedFiles.flatMap(file => this.extractTaskTerms(file)),
    ].map(term => this.normalizeTaskTerm(term)));
    const taskTerms = this.significantTaskTerms(taskProfile.terms)
      .map(term => this.normalizeTaskTerm(term))
      .filter(term => term.length >= 4)
      .filter(term => !this.projectIdentityTerms().has(term))
      .filter(term => !this.specTermsCoverTaskTerm(specTerms, term));

    return Array.from(new Set(taskTerms)).slice(0, 8);
  }

  private projectIdentityTerms(): Set<string> {
    return new Set(this.extractTaskTerms(basename(this.projectRoot)));
  }

  private specTermsCoverTaskTerm(specTerms: Set<string>, taskTerm: string): boolean {
    if (specTerms.has(taskTerm)) {
      return true;
    }

    for (const specTerm of specTerms) {
      if (this.termsAreCloseEnough(specTerm, taskTerm)) {
        return true;
      }
    }

    return false;
  }

  private termsAreCloseEnough(a: string, b: string): boolean {
    const shorter = Math.min(a.length, b.length);
    if (shorter < 6) {
      return false;
    }

    let shared = 0;
    while (shared < shorter && a[shared] === b[shared]) {
      shared += 1;
    }

    return shared >= Math.min(7, shorter - 1);
  }

  private isHighFanoutFile(filePath: string): boolean {
    const nodes = this.store.getNodesByFile(filePath);
    let edgeCount = 0;
    for (const node of nodes) {
      edgeCount += this.store.getEdgesFrom(node.id).length + this.store.getEdgesTo(node.id).length;
    }
    return edgeCount >= 60;
  }

  private inferWorkingSetFocus(workingSet: ContextFile[]): 'frontend' | 'backend' | 'tests' | 'mixed' | 'unknown' {
    const focuses = new Set<'frontend' | 'backend' | 'tests'>();
    for (const file of workingSet.map(entry => entry.file)) {
      if (file.startsWith('tests/')) {
        focuses.add('tests');
      } else if (this.isFrontendFile(file)) {
        focuses.add('frontend');
      } else if (
        file.startsWith('app/')
        || file.startsWith('routes/')
        || file.startsWith('config/')
        || file.startsWith('database/')
      ) {
        focuses.add('backend');
      }
    }

    if (focuses.size === 0) return 'unknown';
    if (focuses.size > 1) return 'mixed';
    return Array.from(focuses)[0] ?? 'unknown';
  }

  private isLowValuePrecedent(filePath: string, terms: string[]): boolean {
    const lower = filePath.toLowerCase();
    if (lower.includes('mock') && !terms.includes('mock')) return true;
    if (lower.includes('/scripts/api.') && !terms.some(term => ['api', 'network', 'request', 'http'].includes(term))) return true;
    if (
      lower.includes('constant')
      && !terms.includes('constant')
      && this.fileTermMatchScore(filePath, this.significantTaskTerms(terms)) <= 0
    ) {
      return true;
    }
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
    const tokens = this.searchTokensForText(filePath);
    let score = 0;

    for (const term of this.rankableTaskTerms(terms)) {
      if (tokens.has(term)) {
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
      provenance: ContextProvenance;
    }>,
    taskProfile: TaskProfile,
    primaryStart: string | null,
  ): void {
    if (taskProfile.mode !== 'audit_communication') {
      return;
    }

    const hasClientFocus = primaryStart
      ? this.isServiceClientPath(primaryStart.toLowerCase())
      : Array.from(fileEntries.keys()).some(file => this.isServiceClientPath(file.toLowerCase()));
    if (!hasClientFocus) {
      return;
    }

    const candidateFiles = this.indexedProjectFiles()
      .filter(file =>
        file.startsWith('config/')
        || file.startsWith('app/Providers/')
        || file.startsWith('src/Providers/'),
      )
      .sort((a, b) =>
        this.infrastructureContextPriority(b) - this.infrastructureContextPriority(a)
        || a.localeCompare(b),
      )
      .slice(0, 4);

    for (const file of candidateFiles) {
      const absolute = join(this.projectRoot, file);
      if (!existsSync(absolute) || fileEntries.has(file)) {
        continue;
      }

      const entry = this.getOrCreateFileEntry(fileEntries, file);
      entry.provenance = 'task_heuristic';
      entry.score += file.startsWith('config/') ? 500 : 220;
      entry.reasons.set('infrastructure wiring for client/service configuration', {
        text: 'infrastructure wiring for client/service configuration',
        provenance: 'task_heuristic',
        confidence: 0.72,
      });
    }
  }

  private infrastructureContextPriority(filePath: string): number {
    const lower = filePath.toLowerCase();
    if (lower === 'config/services.php') return 100;
    if (lower.startsWith('config/') && this.pathHasCommunicationKeyword(lower)) return 90;
    if (lower.startsWith('config/')) return 70;
    if (lower.startsWith('app/providers/') || lower.startsWith('src/providers/')) return 60;
    return 0;
  }

  private addEndpointLiteralContextFiles(
    fileEntries: Map<string, {
      file: string;
      kinds: Set<string>;
      reasons: Map<string, ContextReason>;
      anchors: SubgraphNode[];
      score: number;
      provenance: ContextProvenance;
    }>,
    taskProfile: TaskProfile,
  ): void {
    const candidates = this.inferEndpointLiteralCandidates(taskProfile, 10);
    for (const candidate of candidates) {
      const entry = this.getOrCreateFileEntry(fileEntries, candidate.file);
      if (entry.provenance !== 'explicit_graph') {
        entry.provenance = 'task_heuristic';
      }
      entry.kinds.add(this.primaryKindForFile(candidate.file));
      entry.score += candidate.file.startsWith('resources/js/composables/')
        ? 150
        : candidate.file.startsWith('resources/js/')
          ? 120
          : candidate.file.startsWith('routes/')
            ? 110
            : 70;

      for (const reason of candidate.reasons) {
        entry.reasons.set(reason, {
          text: reason,
          provenance: 'task_heuristic',
          confidence: candidate.confidence,
        });
      }
    }
  }

  private addSpecContextFiles(
    fileEntries: Map<string, {
      file: string;
      kinds: Set<string>;
      reasons: Map<string, ContextReason>;
      anchors: SubgraphNode[];
      score: number;
      provenance: ContextProvenance;
    }>,
    taskProfile: TaskProfile,
  ): void {
    const specContext = taskProfile.specContext;
    if (!specContext) {
      return;
    }

    const specEntry = this.getOrCreateFileEntry(fileEntries, specContext.file);
    if (specEntry.provenance !== 'explicit_graph') {
      specEntry.provenance = 'spec_reference';
    }
    specEntry.kinds.add('spec');
    specEntry.score += 180;
    specEntry.reasons.set('provided spec document', {
      text: 'provided spec document',
      provenance: 'spec_reference',
      confidence: 0.95,
    });

    for (const file of specContext.existingFiles) {
      const entry = this.getOrCreateFileEntry(fileEntries, file);
      if (entry.provenance !== 'explicit_graph') {
        entry.provenance = 'spec_reference';
      }
      entry.kinds.add(this.primaryKindForFile(file));
      entry.score += 1000;
      const reason = `listed in spec ${specContext.file}`;
      entry.reasons.set(reason, {
        text: reason,
        provenance: 'spec_reference',
        confidence: 0.97,
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
      provenance: ContextProvenance;
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

        const nestedContent = this.readProjectTextFile(importedFile);
        if (!nestedContent) {
          continue;
        }
        const nestedImports = this.extractFrontendImportSources(nestedContent)
          .map(source => this.resolveFrontendImport(importedFile, source))
          .filter((file): file is string => file !== null);
        for (const nestedImport of nestedImports) {
          if (
            this.isGeneratedPath(nestedImport)
            || this.isLowValuePrecedent(nestedImport, taskProfile.terms)
            || this.fileTermMatchScore(nestedImport, significantTerms) <= 0
          ) {
            continue;
          }

          const nestedEntry = this.getOrCreateFileEntry(fileEntries, nestedImport);
          if (nestedEntry.provenance !== 'explicit_graph') {
            nestedEntry.provenance = 'task_heuristic';
          }
          nestedEntry.kinds.add(this.primaryKindForFile(nestedImport));
          nestedEntry.score += nestedImport.endsWith('.vue') ? 36 : 32;
          const nestedReason = `imported by ${basename(importedFile)} and matches task terms`;
          nestedEntry.reasons.set(nestedReason, {
            text: nestedReason,
            provenance: 'task_heuristic',
            confidence: Math.max(0.7, candidate.confidence - 0.12),
          });
        }
      }
    }
  }
}
