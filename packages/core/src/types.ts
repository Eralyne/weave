// -- Graph primitives --

export interface WeaveNode {
  id: number;
  filePath: string;
  symbolName: string;
  kind: string;
  language: string;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WeaveEdge {
  id: number;
  sourceId: number;
  targetId: number;
  relationship: string;
  layer: 1 | 2 | 3;
  convention: string | null;
  metadata: Record<string, unknown> | null;
  confidence: number;
}

export interface FileCache {
  filePath: string;
  mtime: number;
  hash: string;
  lastParsed: string;
}

export interface Convention {
  id: number;
  kind: string;
  property: string;
  frequency: number;
  total: number;
  confidence: number;
  exemplarId: number | null;
  metadata: Record<string, unknown> | null;
}

// -- Plugin types --

export interface PluginDetect {
  files: string[];
  contains?: Record<string, string>;
}

export interface EdgeCreation {
  from: string | { resolve: string } | { resolve_class: string } | { resolve_import: string };
  to: string | { resolve: string } | { resolve_class: string } | { resolve_import: string } | { resolve_migration: string } | { all_of_kind: string };
  relationship: string;
  metadata?: Record<string, string>;
}

export interface NodeCreation {
  file: string;
  kind: string;
  metadata?: Record<string, string>;
}

export interface NodeMetadataUpdate {
  kind: string;
  key: string;
  value: string;
}

export interface RuleMatch {
  language: string;
  filePattern?: string;
  pattern: string;
}

export interface ConventionRule {
  name: string;
  description: string;
  match: RuleMatch;
  creates: Array<
    | { edge: EdgeCreation }
    | { node: NodeCreation }
    | { node_metadata: NodeMetadataUpdate }
  >;
}

export interface ConventionPlugin {
  name: string;
  version: string;
  description: string;
  detect: PluginDetect;
  nodeKinds?: string[];
  rules: ConventionRule[];
}

// -- Query types --

export interface SubgraphQuery {
  start: string;
  scope?: string;
  depth?: number;
  options?: SubgraphOptions;
}

export interface SubgraphOptions {
  includeConventions?: boolean;
  includeExemplars?: boolean;
  includeSnippets?: boolean;
  maxTokens?: number;
}

export interface SubgraphResult {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  conventions?: ConventionReport[];
}

export interface SubgraphNode {
  id: number;
  file: string;
  symbol: string;
  kind: string;
  lines: [number, number];
  snippet?: string;
}

export interface SubgraphEdge {
  from: number;
  to: number;
  relationship: string;
  convention: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ConventionReport {
  kind: string;
  rules: string[];
  exemplar?: {
    file: string;
    reason: string;
  };
}

// -- Validation types --

export interface ValidationViolation {
  file: string;
  symbol: string;
  kind: string;
  convention: string;
  frequency: number;
  total: number;
  confidence: number;
  exemplarFile: string | null;
  message: string;
}

// -- Convention override config --

export interface ConventionOverride {
  file?: string;
  kind?: string;
  symbol?: string;
  skipConventions: string[];
  reason: string;
}

export interface WeaveConfig {
  monorepo?: boolean;
  conventionOverrides?: ConventionOverride[];
  plugins?: string[];
}
