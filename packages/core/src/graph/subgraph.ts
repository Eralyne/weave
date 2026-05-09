import fs from 'node:fs';
import type { GraphStore } from './store.js';
import { toProjectAbsolute, toProjectRelative } from '../path-utils.js';
import type {
  SubgraphQuery,
  SubgraphOptions,
  SubgraphResult,
  SubgraphNode,
  SubgraphEdge,
  ImpactAnalysis,
  ConventionReport,
  WeaveNode,
  WeaveEdge,
} from '../types.js';

interface QueueEntry {
  nodeId: number;
  depth: number;
  priority: number;
}

interface StartReference {
  value: string;
  lineStart?: number;
  lineEnd?: number;
}

const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_TOKENS = 4000;
const CONVENTION_LAYER_WEIGHT = 2.0;
const ESTIMATED_TOKENS_PER_NODE = 60;
const ESTIMATED_TOKENS_PER_EDGE = 24;
const ESTIMATED_TOKENS_PER_SNIPPET_LINE = 4;
const DEFAULT_HUB_EDGE_THRESHOLD = 50;

export class SubgraphExtractor {
  constructor(
    private store: GraphStore,
    private projectRoot: string,
  ) {}

  extract(query: SubgraphQuery): SubgraphResult {
    const maxTokens = query.options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const includeSnippets = query.options?.includeSnippets ?? false;
    const includeConventions = query.options?.includeConventions ?? false;

    const startReference = this.parseStartReference(query.start, query.options);
    const depth = query.depth ?? (startReference.lineStart ? 0 : DEFAULT_DEPTH);
    const startNodes = this.resolveStartReference(startReference);
    if (startNodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    const { visitedNodes, collectedEdges } = this.bfsTraversal(startNodes, depth);
    const prunedNodeIds = this.pruneToTokenBudget(visitedNodes, maxTokens, includeSnippets);

    const maxSnippetLines = this.maxSnippetLines(maxTokens, prunedNodeIds.size, includeSnippets);
    const { nodes: resultNodes, truncatedSnippets } = this.buildResultNodes(
      prunedNodeIds,
      includeSnippets,
      maxSnippetLines,
      startReference,
    );
    const maxEdges = this.maxEdgesForTokenBudget(maxTokens, resultNodes.length);
    const resultEdges = this.filterEdges(collectedEdges, prunedNodeIds, maxEdges);
    const omittedNodes = Math.max(0, visitedNodes.size - prunedNodeIds.size);
    const omittedEdges = Math.max(0, collectedEdges.size - resultEdges.length);

    const result: SubgraphResult = {
      nodes: resultNodes,
      edges: resultEdges,
    };

    if (includeConventions) {
      result.conventions = this.buildConventionReports(prunedNodeIds);
    }

    return {
      ...result,
      truncated: omittedNodes > 0 || omittedEdges > 0 || truncatedSnippets > 0,
      budget: {
        maxTokens,
        maxNodes: prunedNodeIds.size,
        maxEdges,
        omittedNodes,
        omittedEdges,
        truncatedSnippets,
      },
    };
  }

  impact(fileOrSymbol: string, options: SubgraphOptions = {}): SubgraphResult {
    const startReference = this.parseStartReference(fileOrSymbol, options);
    const startNodes = this.impactStartNodes(startReference);
    if (startNodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    const visited = new Map<number, number>();
    const collectedEdges = new Map<number, WeaveEdge>();

    const queue: QueueEntry[] = startNodes.map(n => ({
      nodeId: n.id,
      depth: 0,
      priority: 0,
    }));

    while (queue.length > 0) {
      queue.sort((a, b) => b.priority - a.priority);
      const entry = queue.shift()!;

      if (visited.has(entry.nodeId)) {
        continue;
      }
      visited.set(entry.nodeId, entry.depth);

      const incomingEdges = this.store.getEdgesTo(entry.nodeId);
      const outgoingEdges = entry.depth === 0 ? this.store.getEdgesFrom(entry.nodeId) : [];
      const edgesToTraverse = [...incomingEdges, ...outgoingEdges];
      for (const edge of edgesToTraverse) {
        collectedEdges.set(edge.id, edge);
        const neighborId = edge.sourceId === entry.nodeId ? edge.targetId : edge.sourceId;
        if (!visited.has(neighborId)) {
          const priority = edge.layer === 3 ? CONVENTION_LAYER_WEIGHT : 1.0;
          queue.push({
            nodeId: neighborId,
            depth: entry.depth + 1,
            priority,
          });
        }
      }
    }

    const nodeIds = new Set(visited.keys());
    const { nodes: resultNodes } = this.buildResultNodes(nodeIds, false, 0);
    const resultEdges = this.filterEdges(collectedEdges, nodeIds);

    return this.applyImpactBudget({
      nodes: resultNodes,
      edges: resultEdges,
      impact: this.buildImpactAnalysis(startNodes, resultNodes, resultEdges),
    }, options);
  }

  private applyImpactBudget(result: SubgraphResult, options: SubgraphOptions): SubgraphResult {
    if (!result.impact) {
      return result;
    }

    const maxNodes = options.maxNodes
      ?? (options.maxTokens ? Math.max(8, Math.floor(options.maxTokens / 180)) : options.summary ? 20 : 80);
    const maxEdges = options.maxEdges
      ?? (options.maxTokens ? Math.max(12, Math.floor(options.maxTokens / 90)) : options.summary ? 30 : 120);
    const keepNodeIds = new Set<number>();
    const targetFileSet = new Set(result.impact.targetFiles);

    const targetNodes = result.nodes.filter(node => targetFileSet.has(node.file));
    const targetNodesWithCrossFileEdges = new Set<number>();
    for (const edge of result.impact.crossFileEdges) {
      if (targetNodes.some(node => node.id === edge.from)) {
        targetNodesWithCrossFileEdges.add(edge.from);
      }
      if (targetNodes.some(node => node.id === edge.to)) {
        targetNodesWithCrossFileEdges.add(edge.to);
      }
    }
    const maxTargetNodes = options.summary
      ? Math.max(4, Math.min(12, Math.floor(maxNodes / 2)))
      : Number.POSITIVE_INFINITY;
    for (const node of targetNodes
      .sort((a, b) =>
        Number(targetNodesWithCrossFileEdges.has(b.id)) - Number(targetNodesWithCrossFileEdges.has(a.id))
        || a.lines[0] - b.lines[0],
      )
      .slice(0, maxTargetNodes)) {
      keepNodeIds.add(node.id);
    }
    const rankedCrossFileNodes = this.rankImpactCrossFileNodes(
      result.impact.crossFileNodes,
      result.impact.crossFileEdges,
    );
    for (const node of rankedCrossFileNodes.slice(0, maxNodes)) {
      keepNodeIds.add(node.id);
    }

    const nodes = result.nodes.filter(node => keepNodeIds.has(node.id));
    const availableEdges = new Set<string>(
      result.edges.map(edge => `${edge.from}:${edge.to}:${edge.relationship}`),
    );
    const prioritizedEdges = [
      ...result.impact.crossFileEdges,
      ...result.impact.intraFileEdges,
      ...result.edges,
    ];
    const seenEdges = new Set<string>();
    const edges: SubgraphEdge[] = [];

    for (const edge of prioritizedEdges) {
      const key = `${edge.from}:${edge.to}:${edge.relationship}`;
      if (
        edges.length >= maxEdges
        || seenEdges.has(key)
        || !availableEdges.has(key)
        || !keepNodeIds.has(edge.from)
        || !keepNodeIds.has(edge.to)
      ) {
        continue;
      }
      seenEdges.add(key);
      edges.push(edge);
    }

    const impact = this.buildImpactAnalysis(
      this.syntheticStartNodesForImpact(result),
      nodes,
      edges,
    );
    const totalCounts = result.impact.counts;
    const shownKindBreakdown = this.countNodesByKind(impact.crossFileNodes);
    const totalKindBreakdown = this.countNodesByKind(result.impact.crossFileNodes);
    const kindBreakdown = this.mergeKindBreakdowns(shownKindBreakdown, totalKindBreakdown);
    const truncated = impact.counts.crossFileNodes < totalCounts.crossFileNodes
      || impact.counts.crossFileEdges < totalCounts.crossFileEdges
      || impact.counts.intraFileEdges < totalCounts.intraFileEdges;
    const omitted = {
      crossFileNodes: Math.max(0, totalCounts.crossFileNodes - impact.counts.crossFileNodes),
      crossFileEdges: Math.max(0, totalCounts.crossFileEdges - impact.counts.crossFileEdges),
      intraFileEdges: Math.max(0, totalCounts.intraFileEdges - impact.counts.intraFileEdges),
    };

    return {
      nodes,
      edges,
      impact: {
        ...impact,
        kindBreakdown,
        totalCounts,
        truncated,
        budget: {
          summary: Boolean(options.summary),
          maxNodes,
          maxEdges,
          omitted,
          ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        },
      },
    };
  }

  private syntheticStartNodesForImpact(result: SubgraphResult): WeaveNode[] {
    if (!result.impact) {
      return [];
    }

    return result.nodes
      .filter(node => result.impact?.targetFiles.includes(node.file))
      .map(node => ({
        id: node.id,
        filePath: node.file,
        symbolName: node.symbol,
        kind: node.kind,
        language: '',
        lineStart: node.lines[0],
        lineEnd: node.lines[1],
        signature: null,
        metadata: null,
      }));
  }

  private buildImpactAnalysis(
    startNodes: WeaveNode[],
    nodes: SubgraphNode[],
    edges: SubgraphEdge[],
  ): ImpactAnalysis {
    const targetFiles = Array.from(new Set(startNodes.map(node => node.filePath))).sort();
    const targetFileSet = new Set(targetFiles);
    const nodeById = new Map(nodes.map(node => [node.id, node] as const));

    const crossFileEdges = edges.filter(edge => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      return Boolean(from && to && from.file !== to.file);
    });
    const intraFileEdges = edges.filter(edge => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      return Boolean(from && to && from.file === to.file && targetFileSet.has(from.file));
    });
    const crossFileNodes = nodes.filter(node => !targetFileSet.has(node.file));

    return {
      targetFiles,
      crossFileNodes,
      crossFileEdges,
      intraFileEdges,
      kindBreakdown: this.mergeKindBreakdowns(
        this.countNodesByKind(crossFileNodes),
        this.countNodesByKind(crossFileNodes),
      ),
      counts: {
        crossFileNodes: crossFileNodes.length,
        crossFileEdges: crossFileEdges.length,
        intraFileEdges: intraFileEdges.length,
      },
    };
  }

  private countNodesByKind(nodes: SubgraphNode[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    }
    return counts;
  }

  private rankImpactCrossFileNodes(
    nodes: SubgraphNode[],
    edges: SubgraphEdge[],
  ): SubgraphNode[] {
    const scores = new Map<number, number>();
    for (const edge of edges) {
      const weight = this.impactRelationshipWeight(edge.relationship);
      scores.set(edge.from, (scores.get(edge.from) ?? 0) + weight);
      scores.set(edge.to, (scores.get(edge.to) ?? 0) + weight);
    }

    return [...nodes].sort((a, b) =>
      (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
      || this.impactKindPriority(b.kind) - this.impactKindPriority(a.kind)
      || a.file.localeCompare(b.file)
      || a.lines[0] - b.lines[0],
    );
  }

  private impactRelationshipWeight(relationship: string): number {
    switch (relationship) {
      case 'renders':
      case 'routes_to':
        return 10;
      case 'uses_composable':
      case 'renders_child':
        return 8;
      case 'imports':
        return 6;
      case 'calls':
        return 3;
      default:
        return 4;
    }
  }

  private impactKindPriority(kind: string): number {
    switch (kind) {
      case 'action':
      case 'inertia_page':
        return 10;
      case 'component':
      case 'composable':
        return 9;
      case 'route_definition':
      case 'form_request':
      case 'model':
      case 'service':
      case 'migration':
        return 8;
      default:
        return 1;
    }
  }

  private mergeKindBreakdowns(
    shown: Map<string, number>,
    total: Map<string, number>,
  ): Record<string, { shown: number; total: number }> {
    const kinds = Array.from(new Set([...shown.keys(), ...total.keys()])).sort();
    return Object.fromEntries(kinds.map(kind => [
      kind,
      {
        shown: shown.get(kind) ?? 0,
        total: total.get(kind) ?? 0,
      },
    ]));
  }

  private impactStartNodes(startReference: StartReference): WeaveNode[] {
    const resolved = this.resolveStartReference(startReference);
    if (!startReference.lineStart || resolved.length === 0) {
      return resolved;
    }

    const file = toProjectRelative(this.projectRoot, startReference.value);
    const sameFileNodes = this.store.getNodesByFile(file);
    const startIds = new Set(resolved.map(node => node.id));
    const augmented = [...resolved];

    for (const node of sameFileNodes) {
      if (startIds.has(node.id)) {
        continue;
      }
      if (!this.isImpactBoundaryNode(node) && !this.hasExternalImpactEdge(node, file)) {
        continue;
      }
      startIds.add(node.id);
      augmented.push(node);
    }

    return augmented;
  }

  private isImpactBoundaryNode(node: WeaveNode): boolean {
    return [
      'action',
      'class',
      'component',
      'file',
      'inertia_page',
      'route_definition',
      'vue_script',
      'vue_template',
    ].includes(node.kind);
  }

  private hasExternalImpactEdge(node: WeaveNode, file: string): boolean {
    const edges = [...this.store.getEdgesFrom(node.id), ...this.store.getEdgesTo(node.id)];
    return edges.some(edge => {
      const neighborId = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
      const neighbor = this.store.getNodeById(neighborId);
      return Boolean(
        neighbor
        && neighbor.filePath !== file
        && ['imports', 'renders', 'renders_child', 'routes_to', 'uses_composable'].includes(edge.relationship),
      );
    });
  }

  private resolveStartReference(startReference: StartReference): WeaveNode[] {
    const normalizedInput = toProjectRelative(this.projectRoot, startReference.value);

    const nodesByFile = this.store.getNodesByFile(normalizedInput);
    if (nodesByFile.length > 0) {
      return this.filterNodesByLineRange(nodesByFile, startReference);
    }

    let symbolName = normalizedInput;
    let kind: string | undefined;

    const colonIndex = normalizedInput.indexOf(':');
    if (colonIndex !== -1) {
      symbolName = normalizedInput.substring(colonIndex + 1);
      const prefix = normalizedInput.substring(0, colonIndex);
      const fileNodes = this.store.getNodesByFile(prefix);
      if (fileNodes.length > 0) {
        const matched = fileNodes.filter(n => n.symbolName === symbolName);
        return matched.length > 0 ? matched : fileNodes;
      }
      kind = undefined;
    }

    return this.store.findNodeBySymbol(symbolName, kind);
  }

  private parseStartReference(fileOrSymbol: string, options: SubgraphOptions = {}): StartReference {
    const match = fileOrSymbol.match(/^(.+\.(?:php|vue|js|ts|tsx|jsx|py|md|css|scss|json|yaml|yml|sql)):(\d+)(?:-(\d+))?$/);
    if (match) {
      return {
        value: match[1],
        lineStart: Number(match[2]),
        lineEnd: match[3] ? Number(match[3]) : Number(match[2]),
      };
    }
    if (options.lineStart) {
      return {
        value: fileOrSymbol,
        lineStart: options.lineStart,
        lineEnd: options.lineEnd ?? options.lineStart,
      };
    }
    return { value: fileOrSymbol };
  }

  private filterNodesByLineRange(nodes: WeaveNode[], reference: StartReference): WeaveNode[] {
    if (!reference.lineStart) {
      return nodes;
    }

    const lineEnd = reference.lineEnd ?? reference.lineStart;
    const overlapping = nodes.filter(node =>
      node.lineStart <= lineEnd && node.lineEnd >= reference.lineStart!,
    );
    if (overlapping.length > 0) {
      const sorted = [...overlapping].sort((a, b) =>
        this.nodeLineSpan(a) - this.nodeLineSpan(b)
        || this.distanceFromLineRange(a, reference.lineStart!, lineEnd)
        - this.distanceFromLineRange(b, reference.lineStart!, lineEnd)
        || a.kind.localeCompare(b.kind),
      );
      const regionOrSymbolNodes = sorted.filter(node => !['component', 'file'].includes(node.kind));
      if (regionOrSymbolNodes.length > 0) {
        return regionOrSymbolNodes.slice(0, 3);
      }
      const narrowestSpan = this.nodeLineSpan(sorted[0]!);
      const spanCeiling = Math.max(narrowestSpan * 4, narrowestSpan + 20);
      const narrow = sorted.filter(node => this.nodeLineSpan(node) <= spanCeiling);
      return (narrow.length > 0 ? narrow : sorted).slice(0, 3);
    }

    return [...nodes]
      .sort((a, b) =>
        this.distanceFromLineRange(a, reference.lineStart!, lineEnd)
        - this.distanceFromLineRange(b, reference.lineStart!, lineEnd),
      )
      .slice(0, 3);
  }

  private nodeLineSpan(node: WeaveNode): number {
    return Math.max(1, node.lineEnd - node.lineStart + 1);
  }

  private distanceFromLineRange(node: WeaveNode, lineStart: number, lineEnd: number): number {
    if (node.lineStart <= lineEnd && node.lineEnd >= lineStart) {
      return 0;
    }
    if (node.lineEnd < lineStart) {
      return lineStart - node.lineEnd;
    }
    return node.lineStart - lineEnd;
  }

  private bfsTraversal(
    startNodes: WeaveNode[],
    maxDepth: number,
  ): { visitedNodes: Map<number, number>; collectedEdges: Map<number, WeaveEdge> } {
    const visited = new Map<number, number>();
    const collectedEdges = new Map<number, WeaveEdge>();

    const queue: QueueEntry[] = startNodes.map(n => ({
      nodeId: n.id,
      depth: 0,
      priority: 0,
    }));

    while (queue.length > 0) {
      queue.sort((a, b) => b.priority - a.priority);
      const entry = queue.shift()!;

      if (entry.depth > maxDepth || visited.has(entry.nodeId)) {
        continue;
      }
      visited.set(entry.nodeId, entry.depth);

      if (entry.depth > 0 && this.isHubNode(entry.nodeId)) {
        continue;
      }
      if (entry.depth >= maxDepth) {
        continue;
      }

      const outgoing = this.store.getEdgesFrom(entry.nodeId);
      const incoming = this.store.getEdgesTo(entry.nodeId);
      const allEdges = [...outgoing, ...incoming];

      for (const edge of allEdges) {
        collectedEdges.set(edge.id, edge);
        const neighborId = edge.sourceId === entry.nodeId ? edge.targetId : edge.sourceId;
        if (!visited.has(neighborId)) {
          let priority = 1.0;
          if (edge.layer === 3) {
            priority *= CONVENTION_LAYER_WEIGHT;
          }
          queue.push({
            nodeId: neighborId,
            depth: entry.depth + 1,
            priority,
          });
        }
      }
    }

    return { visitedNodes: visited, collectedEdges };
  }

  private isHubNode(nodeId: number): boolean {
    const edgeCount = this.store.getEdgesFrom(nodeId).length + this.store.getEdgesTo(nodeId).length;
    return edgeCount >= DEFAULT_HUB_EDGE_THRESHOLD;
  }

  private pruneToTokenBudget(
    visitedNodes: Map<number, number>,
    maxTokens: number,
    includeSnippets: boolean,
  ): Set<number> {
    const entries = Array.from(visitedNodes.entries())
      .sort((a, b) => a[1] - b[1]);

    const result = new Set<number>();
    let tokenEstimate = 0;

    for (const [nodeId, _depth] of entries) {
      const node = this.store.getNodeById(nodeId);
      if (!node) continue;

      let nodeCost = ESTIMATED_TOKENS_PER_NODE;
      if (includeSnippets) {
        const lineCount = node.lineEnd - node.lineStart + 1;
        nodeCost += Math.min(lineCount, 120) * ESTIMATED_TOKENS_PER_SNIPPET_LINE;
      }

      if (tokenEstimate + nodeCost > maxTokens && result.size > 0) {
        break;
      }

      result.add(nodeId);
      tokenEstimate += nodeCost;
    }

    return result;
  }

  private maxSnippetLines(maxTokens: number, nodeCount: number, includeSnippets: boolean): number {
    if (!includeSnippets) {
      return 0;
    }

    const availableSnippetTokens = Math.max(80, maxTokens - nodeCount * ESTIMATED_TOKENS_PER_NODE);
    return Math.max(
      20,
      Math.min(120, Math.floor(availableSnippetTokens / Math.max(1, nodeCount) / ESTIMATED_TOKENS_PER_SNIPPET_LINE)),
    );
  }

  private maxEdgesForTokenBudget(maxTokens: number, nodeCount: number): number {
    const remainingTokens = Math.max(200, maxTokens - nodeCount * ESTIMATED_TOKENS_PER_NODE);
    return Math.max(20, Math.floor(remainingTokens / ESTIMATED_TOKENS_PER_EDGE));
  }

  private buildResultNodes(
    nodeIds: Set<number>,
    includeSnippets: boolean,
    maxSnippetLines: number,
    snippetFocus?: StartReference,
  ): { nodes: SubgraphNode[]; truncatedSnippets: number } {
    const results: SubgraphNode[] = [];
    let truncatedSnippets = 0;

    for (const nodeId of nodeIds) {
      const node = this.store.getNodeById(nodeId);
      if (!node) continue;

      const resultNode: SubgraphNode = {
        id: node.id,
        file: node.filePath,
        symbol: node.symbolName,
        kind: node.kind,
        lines: [node.lineStart, node.lineEnd],
      };

      if (includeSnippets) {
        const snippetRange = this.snippetRangeForNode(node, maxSnippetLines, snippetFocus);
        const snippet = this.readSnippet(node.filePath, snippetRange[0], snippetRange[1], maxSnippetLines);
        resultNode.snippetLines = snippet.lines;
        resultNode.snippet = snippet.content;
        if (snippet.truncated) {
          truncatedSnippets += 1;
        }
      }

      results.push(resultNode);
    }

    return { nodes: results, truncatedSnippets };
  }

  private filterEdges(
    collectedEdges: Map<number, WeaveEdge>,
    nodeIds: Set<number>,
    maxEdges = Number.POSITIVE_INFINITY,
  ): SubgraphEdge[] {
    const results: SubgraphEdge[] = [];

    for (const edge of collectedEdges.values()) {
      if (results.length >= maxEdges) {
        break;
      }
      if (nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId)) {
        results.push({
          from: edge.sourceId,
          to: edge.targetId,
          relationship: edge.relationship,
          convention: edge.convention,
          metadata: edge.metadata,
        });
      }
    }

    return results;
  }

  private buildConventionReports(nodeIds: Set<number>): ConventionReport[] {
    const kindSet = new Set<string>();
    for (const nodeId of nodeIds) {
      const node = this.store.getNodeById(nodeId);
      if (node) {
        kindSet.add(node.kind);
      }
    }

    const reports: ConventionReport[] = [];

    for (const kind of kindSet) {
      const conventions = this.store.getConventions(kind)
        .filter(convention => convention.confidence >= 0.9);
      if (conventions.length === 0) continue;

      const rules: string[] = [];
      let exemplar: ConventionReport['exemplar'];

      for (const conv of conventions) {
        rules.push(
          `${conv.frequency}/${conv.total} ${kind}s ${conv.property} (confidence: ${conv.confidence.toFixed(2)})`
        );

        if (conv.exemplarId != null && !exemplar) {
          const exemplarNode = this.store.getNodeById(conv.exemplarId);
          if (exemplarNode) {
            exemplar = {
              file: exemplarNode.filePath,
              reason: `Best representative of ${kind} conventions`,
            };
          }
        }
      }

      reports.push({ kind, rules, exemplar });
    }

    return reports;
  }

  private snippetRangeForNode(
    node: WeaveNode,
    maxSnippetLines: number,
    focus?: StartReference,
  ): [number, number] {
    if (!focus?.lineStart) {
      return [node.lineStart, node.lineEnd];
    }

    const focusFile = toProjectRelative(this.projectRoot, focus.value);
    if (focusFile !== node.filePath) {
      return [node.lineStart, node.lineEnd];
    }

    const focusEnd = focus.lineEnd ?? focus.lineStart;
    const padding = Math.max(4, Math.floor(Math.max(20, maxSnippetLines) / 4));
    const start = Math.max(1, focus.lineStart - padding);
    const end = focusEnd + padding;
    return [start, Math.max(start, end)];
  }

  private readSnippet(
    filePath: string,
    lineStart: number,
    lineEnd: number,
    maxLines: number,
  ): { content: string | undefined; lines: [number, number]; truncated: boolean } {
    try {
      const content = fs.readFileSync(toProjectAbsolute(this.projectRoot, filePath), 'utf-8');
      const lines = content.split('\n');
      const startIdx = Math.max(0, lineStart - 1);
      const endIdx = Math.min(lines.length, lineEnd);
      const snippetLines = lines.slice(startIdx, endIdx);
      const truncated = maxLines > 0 && snippetLines.length > maxLines;
      const visibleLines = truncated ? snippetLines.slice(0, maxLines) : snippetLines;
      const visibleStart = startIdx + 1;
      const visibleEnd = Math.max(visibleStart, visibleStart + visibleLines.length - 1);
      const suffix = truncated
        ? `\n... [snippet truncated: ${snippetLines.length - maxLines} more line(s)]`
        : '';
      return {
        content: `${visibleLines.join('\n')}${suffix}`,
        lines: [visibleStart, visibleEnd],
        truncated,
      };
    } catch {
      return { content: undefined, lines: [lineStart, lineEnd], truncated: false };
    }
  }
}
