import fs from 'node:fs';
import type { GraphStore } from './store.js';
import type {
  SubgraphQuery,
  SubgraphResult,
  SubgraphNode,
  SubgraphEdge,
  ConventionReport,
  WeaveNode,
  WeaveEdge,
} from '../types.js';

interface QueueEntry {
  nodeId: number;
  depth: number;
  priority: number;
}

const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_TOKENS = 4000;
const CONVENTION_LAYER_WEIGHT = 2.0;
const ESTIMATED_TOKENS_PER_NODE = 60;
const ESTIMATED_TOKENS_PER_SNIPPET_LINE = 4;

export class SubgraphExtractor {
  constructor(private store: GraphStore) {}

  extract(query: SubgraphQuery): SubgraphResult {
    const depth = query.depth ?? DEFAULT_DEPTH;
    const maxTokens = query.options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const includeSnippets = query.options?.includeSnippets ?? false;
    const includeConventions = query.options?.includeConventions ?? false;

    const startNodes = this.resolveStart(query.start);
    if (startNodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    const { visitedNodes, collectedEdges } = this.bfsTraversal(startNodes, depth);
    const prunedNodeIds = this.pruneToTokenBudget(visitedNodes, maxTokens, includeSnippets);

    const resultNodes = this.buildResultNodes(prunedNodeIds, includeSnippets);
    const resultEdges = this.filterEdges(collectedEdges, prunedNodeIds);

    const result: SubgraphResult = {
      nodes: resultNodes,
      edges: resultEdges,
    };

    if (includeConventions) {
      result.conventions = this.buildConventionReports(prunedNodeIds);
    }

    return result;
  }

  impact(fileOrSymbol: string): SubgraphResult {
    const startNodes = this.resolveStart(fileOrSymbol);
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
      for (const edge of incomingEdges) {
        collectedEdges.set(edge.id, edge);
        const neighborId = edge.sourceId;
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
    const resultNodes = this.buildResultNodes(nodeIds, false);
    const resultEdges = this.filterEdges(collectedEdges, nodeIds);

    return { nodes: resultNodes, edges: resultEdges };
  }

  private resolveStart(fileOrSymbol: string): WeaveNode[] {
    const nodesByFile = this.store.getNodesByFile(fileOrSymbol);
    if (nodesByFile.length > 0) {
      return nodesByFile;
    }

    let symbolName = fileOrSymbol;
    let kind: string | undefined;

    const colonIndex = fileOrSymbol.indexOf(':');
    if (colonIndex !== -1) {
      symbolName = fileOrSymbol.substring(colonIndex + 1);
      const prefix = fileOrSymbol.substring(0, colonIndex);
      const fileNodes = this.store.getNodesByFile(prefix);
      if (fileNodes.length > 0) {
        const matched = fileNodes.filter(n => n.symbolName === symbolName);
        return matched.length > 0 ? matched : fileNodes;
      }
      kind = undefined;
    }

    return this.store.findNodeBySymbol(symbolName, kind);
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
        nodeCost += lineCount * ESTIMATED_TOKENS_PER_SNIPPET_LINE;
      }

      if (tokenEstimate + nodeCost > maxTokens && result.size > 0) {
        break;
      }

      result.add(nodeId);
      tokenEstimate += nodeCost;
    }

    return result;
  }

  private buildResultNodes(nodeIds: Set<number>, includeSnippets: boolean): SubgraphNode[] {
    const results: SubgraphNode[] = [];

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
        resultNode.snippet = this.readSnippet(node.filePath, node.lineStart, node.lineEnd);
      }

      results.push(resultNode);
    }

    return results;
  }

  private filterEdges(
    collectedEdges: Map<number, WeaveEdge>,
    nodeIds: Set<number>,
  ): SubgraphEdge[] {
    const results: SubgraphEdge[] = [];

    for (const edge of collectedEdges.values()) {
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
      const conventions = this.store.getConventions(kind);
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

  private readSnippet(filePath: string, lineStart: number, lineEnd: number): string | undefined {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const startIdx = Math.max(0, lineStart - 1);
      const endIdx = Math.min(lines.length, lineEnd);
      return lines.slice(startIdx, endIdx).join('\n');
    } catch {
      return undefined;
    }
  }
}
