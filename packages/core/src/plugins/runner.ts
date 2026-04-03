import { basename } from 'node:path';
import { minimatch } from 'glob';
import { GraphStore } from '../graph/store.js';
import { TreeSitterParser } from '../parser/parser.js';
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

  constructor(store: GraphStore, parser: TreeSitterParser) {
    this.store = store;
    this.parser = parser;
  }

  /** Apply all rules from a plugin to a file. */
  applyRules(filePath: string, plugin: ConventionPlugin): void {
    for (const rule of plugin.rules) {
      this.applyRule(filePath, rule, plugin.name);
    }
  }

  /** Apply a single rule to a file if it matches language and file pattern. */
  private applyRule(filePath: string, rule: ConventionRule, pluginName: string): void {
    const fileLanguage = this.detectLanguage(filePath);
    if (fileLanguage !== rule.match.language) return;

    if (rule.match.filePattern) {
      if (!minimatch(filePath, rule.match.filePattern)) return;
    }

    const tree = this.parser.parse(filePath);
    if (!tree) return;

    const matches = this.parser.query(tree, rule.match.pattern);
    if (!matches || matches.length === 0) return;

    for (const match of matches) {
      const captures = this.extractCaptures(match);
      captures.set('__current_file__', filePath);
      this.processCreates(filePath, rule.creates, captures, pluginName);
    }
  }

  /** Extract named captures from a tree-sitter query match into a string map. */
  private extractCaptures(match: { captures: Array<{ name: string; node: { text: string } }> }): Captures {
    const captures: Captures = new Map();
    for (const capture of match.captures) {
      captures.set(capture.name, capture.node.text);
    }
    return captures;
  }

  /** Process all creation directives for a single match. */
  private processCreates(
    filePath: string,
    creates: ConventionRule['creates'],
    captures: Captures,
    pluginName: string,
  ): void {
    for (const creation of creates) {
      if ('edge' in creation) {
        this.processEdgeCreation(filePath, creation.edge, captures, pluginName);
      } else if ('node' in creation) {
        this.processNodeCreation(creation.node, captures, pluginName);
      } else if ('node_metadata' in creation) {
        this.processNodeMetadataUpdate(filePath, creation.node_metadata, captures);
      }
    }
  }

  /** Create an edge between resolved source and target nodes. */
  private processEdgeCreation(
    filePath: string,
    edge: EdgeCreation,
    captures: Captures,
    pluginName: string,
  ): void {
    const sourceNodes = this.resolveTarget(edge.from, filePath, captures);
    const targetNodes = this.resolveTarget(edge.to, filePath, captures);

    if (sourceNodes.length === 0 || targetNodes.length === 0) return;

    const metadata = edge.metadata
      ? this.interpolateMetadata(edge.metadata, captures)
      : null;

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
      }
    }
  }

  /** Ensure a node exists for a convention-specified file/kind. */
  private processNodeCreation(
    nodeSpec: NodeCreation,
    captures: Captures,
    _pluginName: string,
  ): void {
    const resolvedFile = this.interpolate(nodeSpec.file, captures);
    const existing = this.store.getNodesByFile(resolvedFile);
    if (existing.length > 0) return;

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
  }

  /** Update metadata on nodes matching the specified kind in the current file. */
  private processNodeMetadataUpdate(
    filePath: string,
    update: NodeMetadataUpdate,
    captures: Captures,
  ): void {
    const nodes = this.store.getNodesByFile(filePath)
      .filter(n => n.kind === update.kind);

    const resolvedValue = this.interpolate(update.value, captures);

    for (const node of nodes) {
      const existing = node.metadata ?? {};
      existing[update.key] = resolvedValue;
      this.store.updateNodeMetadata(node.id, existing);
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
        this.interpolate((target as { resolve: string }).resolve, captures),
      );
    }

    if ('resolve_class' in target) {
      return this.resolveClass(
        this.interpolate((target as { resolve_class: string }).resolve_class, captures),
      );
    }

    if ('resolve_import' in target) {
      return this.resolveImport(
        this.interpolate((target as { resolve_import: string }).resolve_import, captures),
        filePath,
      );
    }

    if ('resolve_migration' in target) {
      return this.resolveMigration(
        this.interpolate((target as { resolve_migration: string }).resolve_migration, captures),
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
    const nodes = this.store.getNodesByFile(resolvedPath);
    if (nodes.length > 0) return nodes;

    // Create a placeholder node for the resolved file
    const symbolName = basename(resolvedPath).replace(/\.[^.]+$/, '');
    const node: WeaveNode = {
      id: 0,
      filePath: resolvedPath,
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
    if (nodes.length > 0) return nodes;

    // Search for partial matches (class name might be short name without namespace)
    const allClasses = this.store.getNodesByKind('class');
    const match = allClasses.filter(n =>
      n.symbolName === className || n.symbolName.endsWith(`\\${className}`),
    );
    return match;
  }

  /**
   * resolve_import — Follow import chains to find the definition.
   * Looks for import edges from the current file that match the symbol name.
   */
  private resolveImport(symbolName: string, filePath: string): WeaveNode[] {
    // Find import edges from the current file
    const fileNodes = this.store.getNodesByFile(filePath);
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
    const fileNodes = this.store.getNodesByFile(filePath);

    // Prefer function/method/class nodes (the enclosing symbol)
    const enclosingKinds = ['function', 'method', 'class', 'action', 'model', 'component', 'composable'];
    const enclosing = fileNodes.filter(n => enclosingKinds.includes(n.kind));

    if (enclosing.length > 0) return [enclosing[0]];

    // Fallback: return first node in the file
    if (fileNodes.length > 0) return [fileNodes[0]];

    return this.resolveCurrentFile(filePath);
  }

  /** current_file — The file being analyzed. */
  private resolveCurrentFile(filePath: string): WeaveNode[] {
    const nodes = this.store.getNodesByFile(filePath);
    if (nodes.length > 0) return [nodes[0]];

    // Create a file-level node
    const symbolName = basename(filePath).replace(/\.[^.]+$/, '');
    const node: WeaveNode = {
      id: 0,
      filePath,
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
      if (value.startsWith('@')) {
        // Direct capture reference: "@props" -> captures.get("props")
        const captureName = value.slice(1);
        result[key] = captures.get(captureName) ?? value;
      } else {
        result[key] = this.interpolate(value, captures);
      }
    }
    return result;
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
}
