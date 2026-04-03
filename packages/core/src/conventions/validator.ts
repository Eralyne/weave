import { ConventionEngine } from './engine.js';
import type {
  Convention,
  ValidationViolation,
  WeaveConfig,
  WeaveNode,
} from '../types.js';
import type { GraphStore } from '../graph/store.js';

/**
 * Validates files against derived conventions. Checks each node in the given
 * files against conventions for its kind, returning violations for any
 * high-confidence conventions (>= 0.9) that are not satisfied.
 */
export class ConventionValidator {
  private engine: ConventionEngine;
  private config: WeaveConfig;
  private store: GraphStore;

  constructor(engine: ConventionEngine, config: WeaveConfig) {
    this.engine = engine;
    this.config = config;
    this.store = engine.store;
  }

  /**
   * Check files against derived conventions.
   * Returns violations for nodes that don't satisfy high-confidence conventions.
   */
  validate(filePaths: string[]): ValidationViolation[] {
    const violations: ValidationViolation[] = [];

    for (const filePath of filePaths) {
      const fileNodes = this.store.getNodesByFile(filePath);
      if (fileNodes.length === 0) continue;

      const fileViolations = this.validateNodes(filePath, fileNodes);
      violations.push(...fileViolations);
    }

    return violations;
  }

  private validateNodes(
    filePath: string,
    nodes: WeaveNode[],
  ): ValidationViolation[] {
    const violations: ValidationViolation[] = [];

    // Group file nodes by kind so we only fetch conventions once per kind
    const nodesByKind = new Map<string, WeaveNode[]>();
    for (const node of nodes) {
      const existing = nodesByKind.get(node.kind);
      if (existing) {
        existing.push(node);
      } else {
        nodesByKind.set(node.kind, [node]);
      }
    }

    for (const [kind, kindNodes] of nodesByKind) {
      const conventions = this.engine.getConventions(kind);
      const highConfidence = conventions.filter(c => c.confidence >= 0.9);
      if (highConfidence.length === 0) continue;

      const exemplar = this.engine.getExemplar(kind);
      const exemplarFile = exemplar?.file ?? null;

      for (const node of kindNodes) {
        for (const conv of highConfidence) {
          if (this.isOverridden(filePath, node.symbolName, kind, conv.property)) {
            continue;
          }

          if (!this.nodeSatisfiesConvention(node, conv)) {
            violations.push({
              file: filePath,
              symbol: node.symbolName,
              kind,
              convention: conv.property,
              frequency: conv.frequency,
              total: conv.total,
              confidence: conv.confidence,
              exemplarFile,
              message:
                `${node.symbolName} is a ${kind} but doesn't ${conv.property}. ` +
                `${conv.frequency}/${conv.total} ${kind}s do.` +
                (exemplarFile ? ` See ${exemplarFile} for reference.` : ''),
            });
          }
        }
      }
    }

    return violations;
  }

  /**
   * Check whether a node satisfies a convention based on its type.
   */
  private nodeSatisfiesConvention(
    node: WeaveNode,
    convention: Convention,
  ): boolean {
    const meta = convention.metadata;
    if (!meta) return true;

    switch (meta.type) {
      case 'structural': {
        const outgoing = this.store.getEdgesFrom(node.id);
        return outgoing.some(edge => {
          if (edge.relationship !== 'extends') return false;
          const target = this.store.getNodeById(edge.targetId);
          return target?.symbolName === meta.baseClass;
        });
      }

      case 'edge_pattern': {
        const direction = meta.direction as string;
        const relationship = meta.relationship as string;
        if (direction === 'outgoing') {
          const outgoing = this.store.getEdgesFrom(node.id);
          return outgoing.some(e => e.relationship === relationship);
        }
        const incoming = this.store.getEdgesTo(node.id);
        return incoming.some(e => e.relationship === relationship);
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
        const outgoing = this.store.getEdgesFrom(node.id);
        const incoming = this.store.getEdgesTo(node.id);
        return [...outgoing, ...incoming].some(edge => {
          if (edge.relationship !== relationship) return false;
          const otherId = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
          const otherNode = this.store.getNodeById(otherId);
          return otherNode?.kind === targetKind;
        });
      }

      default:
        return true;
    }
  }

  /**
   * Check if a convention check is overridden for a specific node.
   * Overrides without a reason field are treated as invalid and ignored.
   */
  private isOverridden(
    filePath: string,
    symbolName: string,
    kind: string,
    conventionProperty: string,
  ): boolean {
    if (!this.config.conventionOverrides) return false;

    for (const override of this.config.conventionOverrides) {
      if (!override.reason) continue;

      if (override.file && override.file !== filePath) continue;
      if (override.symbol && override.symbol !== symbolName) continue;
      if (override.kind && override.kind !== kind) continue;

      if (override.skipConventions.includes(conventionProperty)) {
        return true;
      }
    }

    return false;
  }
}
