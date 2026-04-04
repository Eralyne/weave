import { GraphStore } from '../graph/store.js';
import type {
  Convention,
  WeaveConfig,
  WeaveNode,
  WeaveEdge,
  ConventionOverride,
} from '../types.js';

interface Exemplar {
  nodeId: number;
  file: string;
  reason: string;
}

/**
 * Mines the code graph for coding conventions by analyzing structural patterns
 * across nodes of the same kind. Stores derived conventions in the graph store's
 * conventions table for use by the validator and query API.
 */
export class ConventionEngine {
  readonly store: GraphStore;
  private config: WeaveConfig;
  private conventionsCache: Convention[] = [];

  constructor(store: GraphStore, config: WeaveConfig) {
    this.store = store;
    this.config = config;
  }

  /**
   * Mine the graph for conventions and store them.
   * Groups all nodes by kind, detects patterns, scores confidence,
   * selects exemplars, and persists to the conventions table.
   */
  recompute(): void {
    this.store.clearConventions();

    const allNodes = this.store.getAllNodes();
    const nodesByKind = this.groupByKind(allNodes);

    const conventions: Convention[] = [];

    for (const [kind, nodes] of nodesByKind) {
      if (nodes.length < 2) continue;

      const overrides = this.getOverridesForKind(kind);
      const kindConventions = this.mineKindConventions(kind, nodes, overrides);
      conventions.push(...kindConventions);
    }

    for (const conv of conventions) {
      this.store.insertConvention(conv);
    }

    this.conventionsCache = this.store.getConventions();
  }

  /**
   * Get derived conventions, optionally filtered by kind.
   */
  getConventions(kind?: string): Convention[] {
    if (this.conventionsCache.length === 0) {
      this.conventionsCache = this.store.getConventions();
    }

    if (kind) {
      return this.conventionsCache.filter(c => c.kind === kind);
    }
    return [...this.conventionsCache];
  }

  /**
   * Find the best exemplar for a given kind.
   * If contextNodeId is provided, prefer exemplars structurally closest
   * to the context node (most shared edge patterns).
   */
  getExemplar(kind: string, contextNodeId?: number): Exemplar | null {
    const kindConventions = this.getConventions(kind);
    if (kindConventions.length === 0) return null;

    const nodes = this.store.getNodesByKind(kind);
    if (nodes.length === 0) return null;

    if (contextNodeId !== undefined) {
      return this.findClosestExemplar(kind, nodes, contextNodeId, kindConventions);
    }

    // Default: use the exemplar from the highest-confidence convention
    const sorted = [...kindConventions].sort((a, b) => b.confidence - a.confidence);
    for (const conv of sorted) {
      if (conv.exemplarId !== null) {
        const node = this.store.getNodeById(conv.exemplarId);
        if (node) {
          return {
            nodeId: node.id,
            file: node.filePath,
            reason: `Best representative of ${kind} conventions (highest convention conformance)`,
          };
        }
      }
    }

    return null;
  }

  // -- Private: mining methods --

  private groupByKind(nodes: WeaveNode[]): Map<string, WeaveNode[]> {
    const groups = new Map<string, WeaveNode[]>();
    for (const node of nodes) {
      const existing = groups.get(node.kind);
      if (existing) {
        existing.push(node);
      } else {
        groups.set(node.kind, [node]);
      }
    }
    return groups;
  }

  private mineKindConventions(
    kind: string,
    nodes: WeaveNode[],
    overrides: ConventionOverride[],
  ): Convention[] {
    const conventions: Convention[] = [];

    // Filter out overridden nodes from frequency calculations
    const effectiveNodes = this.filterOverriddenNodes(nodes, overrides);
    const total = effectiveNodes.length;
    if (total < 2) return conventions;

    // Preload edges for all effective nodes
    const nodeEdges = new Map<number, { outgoing: WeaveEdge[]; incoming: WeaveEdge[] }>();
    for (const node of effectiveNodes) {
      nodeEdges.set(node.id, {
        outgoing: this.store.getEdgesFrom(node.id),
        incoming: this.store.getEdgesTo(node.id),
      });
    }

    // 1. Structural: common base classes (extends edges)
    conventions.push(
      ...this.detectStructuralPatterns(kind, effectiveNodes, nodeEdges, total),
    );

    // 2. Edge patterns: common outgoing/incoming edge types
    conventions.push(
      ...this.detectEdgePatterns(kind, effectiveNodes, nodeEdges, total),
    );

    // 3. Naming: regex patterns in symbol names
    conventions.push(
      ...this.detectNamingPatterns(kind, effectiveNodes, total),
    );

    // 4. Location: common file path patterns
    conventions.push(
      ...this.detectLocationPatterns(kind, effectiveNodes, total),
    );

    // 5. Relationship: required edges (every node of kind has edge type X)
    conventions.push(
      ...this.detectRelationshipPatterns(kind, effectiveNodes, nodeEdges, total),
    );

    // Select exemplars for each convention
    for (const conv of conventions) {
      conv.exemplarId = this.selectExemplar(effectiveNodes, nodeEdges, conventions);
    }

    return conventions;
  }

  /**
   * Detect structural patterns: common base classes via 'extends' edges.
   */
  private detectStructuralPatterns(
    kind: string,
    nodes: WeaveNode[],
    nodeEdges: Map<number, { outgoing: WeaveEdge[]; incoming: WeaveEdge[] }>,
    total: number,
  ): Convention[] {
    const conventions: Convention[] = [];

    // Count extends targets
    const extendsCount = new Map<string, number>();
    for (const node of nodes) {
      const edges = nodeEdges.get(node.id);
      if (!edges) continue;

      for (const edge of edges.outgoing) {
        if (edge.relationship === 'extends') {
          const targetNode = this.store.getNodeById(edge.targetId);
          if (targetNode) {
            const key = targetNode.symbolName;
            extendsCount.set(key, (extendsCount.get(key) ?? 0) + 1);
          }
        }
      }
    }

    for (const [baseClass, frequency] of extendsCount) {
      if (frequency >= 2) {
        conventions.push({
          id: 0,
          kind,
          property: `extends ${baseClass}`,
          frequency,
          total,
          confidence: frequency / total,
          exemplarId: null,
          metadata: { type: 'structural', baseClass },
        });
      }
    }

    return conventions;
  }

  /**
   * Detect edge patterns: common outgoing/incoming edge relationship types.
   */
  private detectEdgePatterns(
    kind: string,
    nodes: WeaveNode[],
    nodeEdges: Map<number, { outgoing: WeaveEdge[]; incoming: WeaveEdge[] }>,
    total: number,
  ): Convention[] {
    const conventions: Convention[] = [];

    // Count outgoing edge relationship types
    const outgoingRelCount = new Map<string, number>();
    for (const node of nodes) {
      const edges = nodeEdges.get(node.id);
      if (!edges) continue;

      // Deduplicate: count each relationship type at most once per node
      const seenRels = new Set<string>();
      for (const edge of edges.outgoing) {
        if (edge.relationship === 'extends') continue; // handled by structural
        if (!seenRels.has(edge.relationship)) {
          seenRels.add(edge.relationship);
          outgoingRelCount.set(
            edge.relationship,
            (outgoingRelCount.get(edge.relationship) ?? 0) + 1,
          );
        }
      }
    }

    for (const [relationship, frequency] of outgoingRelCount) {
      if (frequency >= 2) {
        conventions.push({
          id: 0,
          kind,
          property: `has ${relationship} edge`,
          frequency,
          total,
          confidence: frequency / total,
          exemplarId: null,
          metadata: { type: 'edge_pattern', relationship, direction: 'outgoing' },
        });
      }
    }

    // Count incoming edge relationship types
    const incomingRelCount = new Map<string, number>();
    for (const node of nodes) {
      const edges = nodeEdges.get(node.id);
      if (!edges) continue;

      const seenRels = new Set<string>();
      for (const edge of edges.incoming) {
        if (!seenRels.has(edge.relationship)) {
          seenRels.add(edge.relationship);
          incomingRelCount.set(
            edge.relationship,
            (incomingRelCount.get(edge.relationship) ?? 0) + 1,
          );
        }
      }
    }

    for (const [relationship, frequency] of incomingRelCount) {
      if (frequency >= 2) {
        conventions.push({
          id: 0,
          kind,
          property: `has incoming ${relationship} edge`,
          frequency,
          total,
          confidence: frequency / total,
          exemplarId: null,
          metadata: { type: 'edge_pattern', relationship, direction: 'incoming' },
        });
      }
    }

    return conventions;
  }

  /**
   * Detect naming patterns: regex patterns in symbol names.
   * Attempts common conventions like PascalCase suffixes, camelCase prefixes.
   */
  private detectNamingPatterns(
    kind: string,
    nodes: WeaveNode[],
    total: number,
  ): Convention[] {
    const conventions: Convention[] = [];

    // Detect common prefixes (e.g., "use" for composables)
    const prefixCounts = new Map<string, number>();
    for (const node of nodes) {
      const prefix = this.extractCamelPrefix(node.symbolName);
      if (prefix) {
        prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
      }
    }

    for (const [prefix, frequency] of prefixCounts) {
      if (frequency >= 2 && frequency / total >= 0.5) {
        const pattern = `${prefix}{Name}`;
        conventions.push({
          id: 0,
          kind,
          property: `matches naming pattern ${pattern}`,
          frequency,
          total,
          confidence: frequency / total,
          exemplarId: null,
          metadata: {
            type: 'naming',
            pattern,
            regex: `^${prefix}[A-Z]`,
          },
        });
      }
    }

    // Detect common suffixes (e.g., "Action", "Controller", "Request")
    const suffixCounts = new Map<string, number>();
    for (const node of nodes) {
      const suffix = this.extractPascalSuffix(node.symbolName);
      if (suffix) {
        suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
      }
    }

    for (const [suffix, frequency] of suffixCounts) {
      if (frequency >= 2 && frequency / total >= 0.5) {
        const pattern = `{Name}${suffix}`;
        conventions.push({
          id: 0,
          kind,
          property: `matches naming pattern ${pattern}`,
          frequency,
          total,
          confidence: frequency / total,
          exemplarId: null,
          metadata: {
            type: 'naming',
            pattern,
            regex: `[A-Z].*${suffix}$`,
          },
        });
      }
    }

    return conventions;
  }

  /**
   * Detect location patterns: common file path directories.
   */
  private detectLocationPatterns(
    kind: string,
    nodes: WeaveNode[],
    total: number,
  ): Convention[] {
    const conventions: Convention[] = [];

    // Extract directory paths and count
    const dirCounts = new Map<string, number>();
    for (const node of nodes) {
      const dir = this.extractDirectory(node.filePath);
      if (dir) {
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }
    }

    for (const [dir, frequency] of dirCounts) {
      if (frequency >= 2 && frequency / total >= 0.5) {
        conventions.push({
          id: 0,
          kind,
          property: `located in ${dir}`,
          frequency,
          total,
          confidence: frequency / total,
          exemplarId: null,
          metadata: { type: 'location', directory: dir },
        });
      }
    }

    return conventions;
  }

  /**
   * Detect relationship patterns: required edges that most nodes of a kind have.
   * Unlike edge patterns which count relationship types, this checks for the
   * existence of at least one edge of a given relationship type per node.
   */
  private detectRelationshipPatterns(
    kind: string,
    nodes: WeaveNode[],
    nodeEdges: Map<number, { outgoing: WeaveEdge[]; incoming: WeaveEdge[] }>,
    total: number,
  ): Convention[] {
    const conventions: Convention[] = [];

    // For each edge relationship type, count how many nodes have at least one
    // edge (either direction) with a specific target kind
    const relTargetKindCount = new Map<string, number>();

    for (const node of nodes) {
      const edges = nodeEdges.get(node.id);
      if (!edges) continue;

      const seenRelKind = new Set<string>();
      for (const edge of [...edges.outgoing, ...edges.incoming]) {
        const targetId = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
        const targetNode = this.store.getNodeById(targetId);
        if (!targetNode) continue;

        const key = `${edge.relationship}→${targetNode.kind}`;
        if (!seenRelKind.has(key)) {
          seenRelKind.add(key);
          relTargetKindCount.set(key, (relTargetKindCount.get(key) ?? 0) + 1);
        }
      }
    }

    for (const [key, frequency] of relTargetKindCount) {
      if (frequency >= 2) {
        const [relationship, targetKind] = key.split('→');
        conventions.push({
          id: 0,
          kind,
          property: `has ${relationship} relationship to ${targetKind}`,
          frequency,
          total,
          confidence: frequency / total,
          exemplarId: null,
          metadata: { type: 'relationship', relationship, targetKind },
        });
      }
    }

    return conventions;
  }

  // -- Private: exemplar selection --

  /**
   * Select the best exemplar for a set of conventions: the node with the most
   * convention-conforming edges.
   */
  private selectExemplar(
    nodes: WeaveNode[],
    nodeEdges: Map<number, { outgoing: WeaveEdge[]; incoming: WeaveEdge[] }>,
    conventions: Convention[],
  ): number | null {
    let bestNodeId: number | null = null;
    let bestScore = -1;

    for (const node of nodes) {
      const edges = nodeEdges.get(node.id);
      if (!edges) continue;

      let score = 0;
      const allEdges = [...edges.outgoing, ...edges.incoming];

      for (const conv of conventions) {
        if (this.nodeMatchesConvention(node, allEdges, conv)) {
          // Weight by confidence — higher confidence conventions matter more
          score += conv.confidence;
        }
      }

      // Tiebreak by total edge count (more connected = better exemplar)
      score += allEdges.length * 0.01;

      if (score > bestScore) {
        bestScore = score;
        bestNodeId = node.id;
      }
    }

    return bestNodeId;
  }

  /**
   * Find the exemplar structurally closest to a context node.
   */
  private findClosestExemplar(
    kind: string,
    nodes: WeaveNode[],
    contextNodeId: number,
    kindConventions: Convention[],
  ): Exemplar | null {
    const contextOutgoing = this.store.getEdgesFrom(contextNodeId);
    const contextIncoming = this.store.getEdgesTo(contextNodeId);
    const contextEdgeRels = new Set<string>();
    for (const edge of [...contextOutgoing, ...contextIncoming]) {
      contextEdgeRels.add(edge.relationship);
    }

    let bestNode: WeaveNode | null = null;
    let bestScore = -1;

    for (const node of nodes) {
      if (node.id === contextNodeId) continue;

      const outgoing = this.store.getEdgesFrom(node.id);
      const incoming = this.store.getEdgesTo(node.id);
      const allEdges = [...outgoing, ...incoming];

      // Score: shared edge relationship types with context node
      let sharedEdges = 0;
      const nodeEdgeRels = new Set<string>();
      for (const edge of allEdges) {
        nodeEdgeRels.add(edge.relationship);
      }
      for (const rel of contextEdgeRels) {
        if (nodeEdgeRels.has(rel)) sharedEdges++;
      }

      // Also score by convention conformance
      let conventionScore = 0;
      for (const conv of kindConventions) {
        if (this.nodeMatchesConvention(node, allEdges, conv)) {
          conventionScore += conv.confidence;
        }
      }

      const score = sharedEdges * 2 + conventionScore;

      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    if (!bestNode) return null;

    return {
      nodeId: bestNode.id,
      file: bestNode.filePath,
      reason: contextNodeId !== undefined
        ? `Most structurally similar ${kind} to the context node (shared edge patterns)`
        : `Best representative of ${kind} conventions`,
    };
  }

  /**
   * Check whether a node matches a specific convention.
   */
  private nodeMatchesConvention(
    node: WeaveNode,
    allEdges: WeaveEdge[],
    convention: Convention,
  ): boolean {
    const meta = convention.metadata;
    if (!meta) return false;

    switch (meta.type) {
      case 'structural': {
        // Check if node has an extends edge to the specified base class
        return allEdges.some(edge => {
          if (edge.relationship !== 'extends' || edge.sourceId !== node.id) return false;
          const target = this.store.getNodeById(edge.targetId);
          return target?.symbolName === meta.baseClass;
        });
      }

      case 'edge_pattern': {
        const direction = meta.direction as string;
        const relationship = meta.relationship as string;
        if (direction === 'outgoing') {
          return allEdges.some(
            e => e.relationship === relationship && e.sourceId === node.id,
          );
        }
        return allEdges.some(
          e => e.relationship === relationship && e.targetId === node.id,
        );
      }

      case 'naming': {
        const regex = meta.regex as string;
        return new RegExp(regex).test(node.symbolName);
      }

      case 'location': {
        const directory = meta.directory as string;
        return node.filePath.startsWith(directory);
      }

      case 'relationship': {
        const relationship = meta.relationship as string;
        const targetKind = meta.targetKind as string;
        return allEdges.some(edge => {
          if (edge.relationship !== relationship) return false;
          const otherId = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
          const otherNode = this.store.getNodeById(otherId);
          return otherNode?.kind === targetKind;
        });
      }

      default:
        return false;
    }
  }

  // -- Private: override handling --

  private getOverridesForKind(kind: string): ConventionOverride[] {
    if (!this.config.conventionOverrides) return [];

    return this.config.conventionOverrides.filter(override => {
      // Overrides without a reason are invalid and ignored
      if (!override.reason) return false;
      return override.kind === kind || override.kind === undefined;
    });
  }

  /**
   * Filter out nodes that are fully overridden (all conventions skipped)
   * from frequency calculations.
   */
  private filterOverriddenNodes(
    nodes: WeaveNode[],
    overrides: ConventionOverride[],
  ): WeaveNode[] {
    if (overrides.length === 0) return nodes;

    return nodes.filter(node => {
      for (const override of overrides) {
        if (!this.overrideMatchesNode(override, node)) continue;
        // Node matches an override — exclude from frequency calculations
        return false;
      }
      return true;
    });
  }

  private overrideMatchesNode(override: ConventionOverride, node: WeaveNode): boolean {
    if (override.file && override.file !== node.filePath) return false;
    if (override.symbol && override.symbol !== node.symbolName) return false;
    if (override.kind && override.kind !== node.kind) return false;
    return true;
  }

  // -- Private: string utilities --

  /**
   * Extract a camelCase prefix (lowercase leading portion before first uppercase).
   * e.g., "useBattleGrid" -> "use", "handleClick" -> "handle"
   */
  private extractCamelPrefix(name: string): string | null {
    const match = name.match(/^([a-z]+)[A-Z]/);
    return match ? match[1] : null;
  }

  /**
   * Extract a PascalCase suffix (last uppercase word).
   * e.g., "ResolveCombatTurnAction" -> "Action", "UserRequest" -> "Request"
   */
  private extractPascalSuffix(name: string): string | null {
    const match = name.match(/([A-Z][a-z]+)$/);
    return match ? match[1] : null;
  }

  /**
   * Extract the directory portion of a file path (up to and including trailing slash).
   * e.g., "app/Models/User.php" -> "app/Models/"
   */
  private extractDirectory(filePath: string): string | null {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash <= 0) return null;
    return filePath.substring(0, lastSlash + 1);
  }
}
