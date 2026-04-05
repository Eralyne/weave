import { basename } from 'node:path';
import { minimatch } from 'minimatch';
import { GraphStore } from '../graph/store.js';
import { IndexingDiagnosticsCollector } from '../indexing-diagnostics.js';
import { TreeSitterParser } from '../parser/parser.js';
import { toProjectRelative } from '../path-utils.js';
import type {
  ConventionPlugin,
  ConventionRule,
  EdgeCreation,
  NodeCreation,
  NodeMetadataUpdate,
  WeaveNode,
} from '../types.js';

/** Captured variables from a tree-sitter query match. */
type Captures = Map<string, string>;

/**
 * Applies convention plugin rules against parsed files,
 * creating graph edges, nodes, and metadata updates.
 */
export class PluginRunner {
  private store: GraphStore;
  private parser: TreeSitterParser;
  private projectRoot: string;

  constructor(store: GraphStore, parser: TreeSitterParser, projectRoot: string = process.cwd()) {
    this.store = store;
    this.parser = parser;
    this.projectRoot = projectRoot;
  }

  /** Relativize an absolute path against the project root. */
  private relPath(filePath: string): string {
    return toProjectRelative(this.projectRoot, filePath);
  }

  /** Apply all rules from a plugin to a file. */
  applyRules(
    filePath: string,
    plugin: ConventionPlugin,
    diagnostics?: IndexingDiagnosticsCollector,
  ): void {
    for (const rule of plugin.rules) {
      this.applyRule(filePath, rule, plugin.name, diagnostics);
    }
  }

  /** Apply a single rule to a file if it matches language and file pattern. */
  private applyRule(
    filePath: string,
    rule: ConventionRule,
    pluginName: string,
    diagnostics?: IndexingDiagnosticsCollector,
  ): void {
    const relativeFilePath = this.relPath(filePath);
    diagnostics?.recordRuleFileEvaluated(pluginName, rule.name, relativeFilePath);
    const fileLanguage = this.detectLanguage(filePath);
    // Vue SFCs contain TypeScript in <script setup>, so allow typescript rules on .vue files
    const languageMatches = fileLanguage === rule.match.language
      || (fileLanguage === 'vue' && rule.match.language === 'typescript');
    if (!languageMatches) return;

    if (rule.match.filePattern) {
      if (!minimatch(relativeFilePath, rule.match.filePattern)) return;
    }

    let tree;
    let lineOffset = 0;
    // For Vue files with typescript rules, extract and parse the <script> block as TS
    if (fileLanguage === 'vue' && rule.match.language === 'typescript') {
      const source = this.parser.readSource(filePath);
      const scriptBlock = this.extractVueScriptBlock(source);
      if (!scriptBlock) return;
      lineOffset = scriptBlock.startLine;
      tree = this.parser.parseString(scriptBlock.text, 'typescript');
    } else {
      tree = this.parser.parse(filePath);
    }
    if (!tree) return;

    let matches;
    try {
      matches = this.parser.query(tree, rule.match.pattern);
    } catch (error) {
      // Tree-sitter query pattern doesn't match this grammar — skip rule silently
      diagnostics?.recordQueryError(pluginName, rule.name, relativeFilePath, error);
      return;
    }
    if (!matches || matches.length === 0) return;

    for (const match of matches) {
      diagnostics?.recordRuleMatch(pluginName, rule.name);
      const captures = this.extractCaptures(match, lineOffset);
      captures.set('__current_file__', relativeFilePath);
      this.processCreates(filePath, rule, captures, pluginName, diagnostics);
    }
  }

  /** Extract named captures from a tree-sitter query match into a string map. */
  private extractCaptures(
    match: {
      captures: Array<{
        name: string;
        node: { text: string; startPosition?: { row: number } };
      }>;
    },
    lineOffset: number,
  ): Captures {
    const captures: Captures = new Map();
    let firstCaptureLine: number | undefined;
    for (const capture of match.captures) {
      captures.set(capture.name, capture.node.text);
      const captureLine = capture.node.startPosition?.row;
      if (captureLine !== undefined) {
        const normalizedLine = captureLine + 1 + lineOffset;
        if (firstCaptureLine === undefined || normalizedLine < firstCaptureLine) {
          firstCaptureLine = normalizedLine;
        }
      }
    }
    if (firstCaptureLine !== undefined) {
      captures.set('__match_line__', String(firstCaptureLine));
    }
    return captures;
  }

  /** Process all creation directives for a single match. */
  private processCreates(
    filePath: string,
    rule: ConventionRule,
    captures: Captures,
    pluginName: string,
    diagnostics?: IndexingDiagnosticsCollector,
  ): void {
    for (const creation of rule.creates) {
      if ('node' in creation) {
        this.processNodeCreation(creation.node, captures, pluginName, rule.name, diagnostics);
      }
    }

    for (const creation of rule.creates) {
      if ('node_metadata' in creation) {
        this.processNodeMetadataUpdate(
          filePath,
          creation.node_metadata,
          captures,
          pluginName,
          rule.name,
          diagnostics,
        );
      }
    }

    for (const creation of rule.creates) {
      if ('edge' in creation) {
        this.processEdgeCreation(filePath, creation.edge, captures, pluginName, rule.name, diagnostics);
      }
    }
  }

  /** Create an edge between resolved source and target nodes. */
  private processEdgeCreation(
    filePath: string,
    edge: EdgeCreation,
    captures: Captures,
    pluginName: string,
    ruleName: string,
    diagnostics?: IndexingDiagnosticsCollector,
  ): void {
    const sourceNodes = this.resolveTarget(edge.from, filePath, captures);
    const targetNodes = this.resolveTarget(edge.to, filePath, captures);
    const relativeFilePath = this.relPath(filePath);

    if (sourceNodes.length === 0 || targetNodes.length === 0) {
      diagnostics?.recordL3EdgeSkipped(
        pluginName,
        ruleName,
        relativeFilePath,
        edge.relationship,
        this.missingEndpointReason(sourceNodes.length === 0, targetNodes.length === 0),
        {
          from: typeof edge.from === 'string' ? edge.from : edge.from,
          to: typeof edge.to === 'string' ? edge.to : edge.to,
        },
      );
      return;
    }

    const metadata = edge.metadata
      ? this.interpolateMetadata(edge.metadata, captures)
      : null;

    let createdEdges = 0;
    for (const source of sourceNodes) {
      for (const target of targetNodes) {
        this.store.createEdge({
          sourceId: source.id,
          targetId: target.id,
          relationship: edge.relationship,
          layer: 3,
          convention: pluginName,
          metadata,
          confidence: 1.0,
        });
        createdEdges++;
      }
    }
    diagnostics?.recordL3EdgeCreated(pluginName, ruleName, relativeFilePath, createdEdges);
  }

  /** Ensure a node exists for a convention-specified file/kind. */
  private processNodeCreation(
    nodeSpec: NodeCreation,
    captures: Captures,
    pluginName: string,
    ruleName: string,
    diagnostics?: IndexingDiagnosticsCollector,
  ): void {
    const resolvedFile = this.relPath(this.interpolate(nodeSpec.file, captures));
    const existing = this.store.getNodesByFile(resolvedFile)
      .find(node => node.kind === nodeSpec.kind);
    if (existing) return;

    const symbolName = basename(resolvedFile).replace(/\.[^.]+$/, '');
    this.store.upsertNode({
      id: 0,
      filePath: resolvedFile,
      symbolName,
      kind: nodeSpec.kind,
      language: this.detectLanguage(resolvedFile),
      lineStart: 1,
      lineEnd: 1,
      signature: null,
      metadata: nodeSpec.metadata
        ? this.interpolateMetadata(nodeSpec.metadata, captures)
        : null,
    });
    diagnostics?.recordNodeCreated(pluginName, ruleName, resolvedFile);
  }

  /** Update metadata on nodes matching the specified kind in the current file. */
  private processNodeMetadataUpdate(
    filePath: string,
    update: NodeMetadataUpdate,
    captures: Captures,
    pluginName: string,
    ruleName: string,
    diagnostics?: IndexingDiagnosticsCollector,
  ): void {
    const relativeFilePath = this.relPath(filePath);
    const nodes = this.store.getNodesByFile(relativeFilePath)
      .filter(n => n.kind === update.kind);

    const resolvedValue = this.resolveValue(update.value, captures);

    for (const node of nodes) {
      const existing = node.metadata ?? {};
      existing[update.key] = resolvedValue;
      this.store.updateNodeMetadata(node.id, existing);
    }
    if (nodes.length > 0) {
      diagnostics?.recordMetadataUpdated(pluginName, ruleName, relativeFilePath, nodes.length);
    }
  }

  /**
   * Resolve a target specifier to one or more graph nodes.
   * Handles all resolution strategies defined in the spec.
   */
  private resolveTarget(
    target: EdgeCreation['from'] | EdgeCreation['to'],
    filePath: string,
    captures: Captures,
  ): WeaveNode[] {
    // String shorthand: "current_symbol" or "current_file"
    if (typeof target === 'string') {
      return this.resolveStringTarget(target, filePath, captures);
    }

    // Object with a resolution strategy key
    if ('resolve' in target) {
      return this.resolveFilePath(
        this.resolveValue((target as { resolve: string }).resolve, captures),
      );
    }

    if ('resolve_class' in target) {
      return this.resolveClass(
        this.resolveValue((target as { resolve_class: string }).resolve_class, captures),
      );
    }

    if ('resolve_import' in target) {
      return this.resolveImport(
        this.resolveValue((target as { resolve_import: string }).resolve_import, captures),
        filePath,
      );
    }

    if ('resolve_migration' in target) {
      return this.resolveMigration(
        this.resolveValue((target as { resolve_migration: string }).resolve_migration, captures),
      );
    }

    if ('all_of_kind' in target) {
      return this.resolveAllOfKind(
        (target as { all_of_kind: string }).all_of_kind,
      );
    }

    return [];
  }

  /** Resolve string targets: "current_symbol" and "current_file". */
  private resolveStringTarget(target: string, filePath: string, captures: Captures): WeaveNode[] {
    switch (target) {
      case 'current_symbol': {
        return this.resolveCurrentSymbol(filePath, captures);
      }
      case 'current_file': {
        return this.resolveCurrentFile(filePath);
      }
      default: {
        // Treat as a file path with possible interpolation
        const resolved = this.interpolate(target, captures);
        return this.resolveFilePath(resolved);
      }
    }
  }

  /**
   * resolve — Interpolate captured variables into a file path,
   * find or create the target node.
   */
  private resolveFilePath(resolvedPath: string): WeaveNode[] {
    const relResolved = this.relPath(resolvedPath);
    const nodes = this.store.getNodesByFile(relResolved);
    if (nodes.length > 0) return this.preferredFileNodes(nodes);

    // Create a placeholder node for the resolved file
    const symbolName = basename(relResolved).replace(/\.[^.]+$/, '');
    const node: WeaveNode = {
      id: 0,
      filePath: relResolved,
      symbolName,
      kind: 'file',
      language: this.detectLanguage(resolvedPath),
      lineStart: 1,
      lineEnd: 1,
      signature: null,
      metadata: null,
    };

    const created = this.store.upsertNode(node);
    return created ? [created] : [];
  }

  /**
   * resolve_class — Find a node by class name searching the graph store.
   */
  private resolveClass(className: string): WeaveNode[] {
    const nodes = this.store.findNodeBySymbol(className);
    if (nodes.length > 0) {
      const specialized = nodes.filter(node => node.kind !== 'class' && node.kind !== 'file');
      return specialized.length > 0 ? specialized : nodes;
    }

    // Search for partial matches (class name might be short name without namespace)
    const allClasses = this.store.getNodesByKind('class');
    const match = allClasses.filter(n =>
      n.symbolName === className || n.symbolName.endsWith(`\\${className}`),
    );
    return match;
  }

  private preferredFileNodes(nodes: WeaveNode[]): WeaveNode[] {
    const priority = (kind: string): number => {
      const priorities: Record<string, number> = {
        inertia_page: 100,
        action: 95,
        model: 95,
        migration: 95,
        form_request: 95,
        policy: 95,
        event: 95,
        listener: 95,
        route_definition: 95,
        composable: 90,
        component: 85,
        class: 80,
        function: 75,
        file: 10,
        method: 5,
        export: 1,
      };
      return priorities[kind] ?? 50;
    };

    const bestPriority = Math.max(...nodes.map(node => priority(node.kind)));
    return nodes.filter(node => priority(node.kind) === bestPriority);
  }

  /**
   * resolve_import — Follow import chains to find the definition.
   * Looks for import edges from the current file that match the symbol name.
   */
  private resolveImport(symbolName: string, filePath: string): WeaveNode[] {
    // Find import edges from the current file
    const fileNodes = this.store.getNodesByFile(this.relPath(filePath));
    for (const fileNode of fileNodes) {
      const edges = this.store.getEdgesFrom(fileNode.id);
      for (const edge of edges) {
        if (edge.relationship === 'imports') {
          const targetNode = this.store.getNodeById(edge.targetId);
          if (targetNode && targetNode.symbolName === symbolName) {
            return [targetNode];
          }
        }
      }
    }

    // Fallback: search globally by symbol name
    return this.store.findNodeBySymbol(symbolName);
  }

  /**
   * resolve_migration — Find migration file by table name.
   * Scans nodes in database/migrations/ whose metadata or content references the table.
   */
  private resolveMigration(tableName: string): WeaveNode[] {
    const migrationNodes = this.store.findNodesByFilePrefix('database/migrations/');
    const match = migrationNodes.filter(n => {
      if (n.metadata && typeof n.metadata === 'object') {
        const meta = n.metadata as Record<string, unknown>;
        if (meta['table'] === tableName) return true;
      }
      // Convention: migration files often contain the table name
      if (n.filePath.includes(tableName)) return true;
      return false;
    });

    if (match.length > 0) return match;

    // Fallback: search for nodes with kind 'migration' that reference this table
    const allMigrations = this.store.getNodesByKind('migration');
    return allMigrations.filter(n => {
      if (n.metadata && typeof n.metadata === 'object') {
        return (n.metadata as Record<string, unknown>)['table'] === tableName;
      }
      return n.filePath.includes(tableName);
    });
  }

  /** all_of_kind — Get all nodes of a specific kind. */
  private resolveAllOfKind(kind: string): WeaveNode[] {
    return this.store.getNodesByKind(kind);
  }

  /** current_symbol — The enclosing function/class containing the match. */
  private resolveCurrentSymbol(filePath: string, captures: Captures): WeaveNode[] {
    // The tree-sitter match is within a function/class — find the enclosing symbol
    const fileNodes = this.store.getNodesByFile(this.relPath(filePath));

    // Prefer function/method/class nodes (the enclosing symbol)
    const enclosingKinds = ['function', 'method', 'class', 'action', 'model', 'component', 'composable'];
    const matchLine = Number(captures.get('__match_line__'));
    const enclosing = fileNodes
      .filter(n => enclosingKinds.includes(n.kind))
      .filter(n => !Number.isNaN(matchLine)
        ? n.lineStart <= matchLine && n.lineEnd >= matchLine
        : true)
      .sort((a, b) => {
        const aRange = a.lineEnd - a.lineStart;
        const bRange = b.lineEnd - b.lineStart;
        return aRange - bRange;
      });

    if (enclosing.length > 0) return [enclosing[0]];

    // Fallback: return first node in the file
    if (fileNodes.length > 0) return [fileNodes[0]];

    return this.resolveCurrentFile(filePath);
  }

  /** current_file — The file being analyzed. */
  private resolveCurrentFile(filePath: string): WeaveNode[] {
    const relFile = this.relPath(filePath);
    const nodes = this.store.getNodesByFile(relFile);
    const fileNode = nodes.find(node => node.kind === 'file');
    if (fileNode) return [fileNode];

    // Create a file-level node
    const symbolName = basename(relFile).replace(/\.[^.]+$/, '');
    const node: WeaveNode = {
      id: 0,
      filePath: relFile,
      symbolName,
      kind: 'file',
      language: this.detectLanguage(filePath),
      lineStart: 1,
      lineEnd: 1,
      signature: null,
      metadata: null,
    };

    const created = this.store.upsertNode(node);
    return created ? [created] : [];
  }

  private extractVueScriptBlock(source: string): { text: string; startLine: number } | null {
    const lines = source.split('\n');
    let inScript = false;
    let isSetupScript = false;
    let startLine = 0;
    const scriptLines: string[] = [];
    let fallback: { text: string; startLine: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (!inScript) {
        const scriptMatch = trimmed.match(/^<script\b([^>]*)>/);
        if (!scriptMatch) continue;

        inScript = true;
        isSetupScript = scriptMatch[1].includes('setup');
        startLine = i;
        scriptLines.length = 0;
        continue;
      }

      if (trimmed === '</script>') {
        inScript = false;
        const result = { text: scriptLines.join('\n'), startLine };
        if (isSetupScript) {
          return result;
        }
        fallback = result;
        continue;
      }

      scriptLines.push(lines[i]);
    }

    return fallback;
  }

  /**
   * Interpolate {@capture_name} placeholders in a string with captured values.
   * Also supports {current_file} as a special variable.
   */
  private interpolate(template: string, captures: Captures): string {
    return template.replace(/\{@(\w+)\}/g, (_match, name: string) => {
      return captures.get(name) ?? '';
    }).replace(/\{current_file\}/g, () => {
      return captures.get('__current_file__') ?? '';
    });
  }

  /** Interpolate all values in a metadata record. */
  private interpolateMetadata(
    metadata: Record<string, string>,
    captures: Captures,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      result[key] = this.resolveValue(value, captures);
    }
    return result;
  }

  private resolveValue(value: string, captures: Captures): string {
    if (value.startsWith('@')) {
      const captureName = value.slice(1);
      return captures.get(captureName) ?? value;
    }
    return this.interpolate(value, captures);
  }

  /** Detect language from file extension. */
  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const languageMap: Record<string, string> = {
      'php': 'php',
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'vue': 'vue',
      'py': 'python',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'java': 'java',
      'kt': 'kotlin',
      'swift': 'swift',
      'css': 'css',
      'scss': 'scss',
      'yaml': 'yaml',
      'yml': 'yaml',
      'json': 'json',
      'sql': 'sql',
    };
    return languageMap[ext] ?? ext;
  }

  private missingEndpointReason(sourceMissing: boolean, targetMissing: boolean): string {
    if (sourceMissing && targetMissing) return 'missing_source_and_target';
    if (sourceMissing) return 'missing_source';
    if (targetMissing) return 'missing_target';
    return 'unknown';
  }
}
