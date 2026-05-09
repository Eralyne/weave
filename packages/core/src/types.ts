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
  task?: string;
  scope?: string;
  fromSpec?: string;
  fromSpecText?: string;
  depth?: number;
  options?: SubgraphOptions;
}

export interface SubgraphOptions {
  includeConventions?: boolean;
  includeExemplars?: boolean;
  includeSnippets?: boolean;
  lineStart?: number;
  lineEnd?: number;
  maxTokens?: number;
  summary?: boolean;
  maxNodes?: number;
  maxEdges?: number;
  includeSpecContext?: boolean;
  task?: string;
  scope?: string;
  fromSpec?: string;
  fromSpecText?: string;
}

export interface SubgraphResult {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  resolution?: {
    file: string;
    status: 'ok' | 'missing_file' | 'not_indexed';
    message: string;
  };
  conventions?: ConventionReport[];
  impact?: ImpactAnalysis;
  truncated?: boolean;
  budget?: {
    maxTokens?: number;
    maxNodes?: number;
      maxEdges?: number;
      omittedNodes?: number;
      omittedEdges?: number;
      truncatedSnippets?: number;
  };
  specContext?: QuerySpecContext;
}

export interface ContextBundleQuery {
  start: string;
  scope?: string;
  fromSpec?: string;
  fromSpecText?: string;
  depth?: number;
  maxFiles?: number;
  maxConstraints?: number;
  maxExemplars?: number;
}

export interface ContextBundle {
  workingSet: ContextFile[];
  constraints: ContextConstraint[];
  exemplars: ContextExemplar[];
}

export interface QuerySpecContext {
  file: string;
  digest: string;
  mode: 'summary';
  note: string;
  relatedExistingFiles: string[];
  lineAnchoredQueries: BootstrapSpecLineAnchoredQuery[];
  plannedFiles: string[];
  likelyNewFileExemplars: BootstrapPlannedFileExemplar[];
  plannedFileExemplarRefs: Array<{
    file: string;
	    kind: string | null;
	    exemplarFile: string | null;
	    confidence: number;
	    coMentionConfidence?: number;
	    shapeMatchConfidence?: number;
	    confidenceReason?: string;
	  }>;
  plannedFilePatternRefs: Array<{
    file: string;
    kind: string | null;
    role?: {
      family: string;
      primary: string;
    };
    status: BootstrapPlannedFilePattern['status'];
    directExemplarFile: string | null;
    confidence: number;
  }>;
}

export interface BootstrapQuery {
  task: string;
  start?: string;
  fromSpec?: string;
  fromSpecText?: string;
  scope?: string;
  compact?: boolean;
  depth?: number;
  maxFiles?: number;
  maxConstraints?: number;
  maxExemplars?: number;
  maxEntryCandidates?: number;
}

export interface BootstrapEntryCandidate {
  file: string;
  confidence: number;
  reasons: string[];
}

export interface BootstrapPayload {
  task: string;
  start: string;
  startSource: 'provided' | 'inferred';
  taskMode?: 'implementation' | 'audit_communication' | 'audit_architecture';
  spec?: BootstrapSpecContext | null;
  scopeMismatch?: {
    expectedFocus: 'frontend' | 'backend' | 'tests';
    actualFocus: 'frontend' | 'backend' | 'tests' | 'mixed' | 'unknown';
    reason: string;
  } | null;
  warnings?: BootstrapWarning[];
  entryCandidates: BootstrapEntryCandidate[];
  /**
   * Top-level aliases for context.*. Kept to make the MCP payload easy for
   * agents that scan the bootstrap root before reading nested context.
   */
  workingSet: ContextFile[];
  constraints: ContextConstraint[];
  exemplars: ContextExemplar[];
  context: ContextBundle;
  operatingMode: 'weave_first';
  guidance: string[];
  fallbackPolicy: string[];
  prompt: string;
}

export interface BootstrapSpecContext {
  file: string;
  referencedFiles: string[];
  lineReferences?: BootstrapSpecLineReference[];
  lineAnchoredQueries?: BootstrapSpecLineAnchoredQuery[];
  existingFileEdges?: BootstrapExistingFileEdgeSummary[];
  existingFiles: string[];
  existingTargets?: string[];
  missingFiles: string[];
  likelyNewFiles: string[];
  plannedFiles?: string[];
  staleSpecRefs?: string[];
  likelyNewFileExemplars?: BootstrapPlannedFileExemplar[];
  plannedFilePatterns?: BootstrapPlannedFilePattern[];
  suspiciousReferences: string[];
  novelPathPrefixes: string[];
  terms?: string[];
  termIndex?: string[];
}

export interface BootstrapSpecLineReference {
  file: string;
  lineStart: number;
  lineEnd?: number;
}

export interface BootstrapSpecLineAnchoredQuery {
  file: string;
  lineStart: number;
  lineEnd?: number;
  query: string;
}

export interface BootstrapExistingFileEdgeSummary {
  file: string;
  edges: BootstrapExistingFileEdge[];
  totalEdges?: number;
  omittedEdges?: number;
}

export interface BootstrapExistingFileEdge {
  direction: 'incoming' | 'outgoing';
  relationship: string;
  convention: string | null;
  sourceFile: string;
  sourceSymbol: string;
  sourceKind: string;
  targetFile: string;
  targetSymbol: string;
  targetKind: string;
  metadata?: Record<string, unknown>;
}

export interface BootstrapPlannedFileExemplar {
  file: string;
  kind: string | null;
  exemplarFile: string | null;
  exemplarNodeId: number | null;
  reason: string;
  confidence: number;
  coMentionConfidence?: number;
  shapeMatchConfidence?: number;
  confidenceReason?: string;
}

export interface BootstrapPlannedFilePattern {
  file: string;
  kind: string | null;
  role?: {
    family: string;
    primary: string;
  };
  status: 'direct_exemplar' | 'adjacent_evidence' | 'evidence_gap';
  confidence: number;
  directExemplarFile: string | null;
  constructionPatterns: BootstrapPatternEvidence[];
  configPatterns: BootstrapPatternEvidence[];
  usageExamples: BootstrapPatternEvidence[];
  notes: string[];
}

export interface BootstrapPatternEvidence {
  pattern: string;
  confidence: number;
  files: string[];
  reason: string;
}

export interface BootstrapWarning {
  code: string;
  message: string;
  files?: string[];
  terms?: string[];
  details?: Record<string, unknown>;
}

export interface SubgraphNode {
  id: number;
  file: string;
  symbol: string;
  kind: string;
  lines: [number, number];
  snippetLines?: [number, number];
  snippet?: string;
}

export interface SubgraphEdge {
  from: number;
  to: number;
  relationship: string;
  convention: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ImpactAnalysis {
  targetFiles: string[];
  crossFileNodes: SubgraphNode[];
  crossFileEdges: SubgraphEdge[];
  intraFileEdges: SubgraphEdge[];
  kindBreakdown?: Record<string, { shown: number; total: number }>;
  counts: {
    crossFileNodes: number;
    crossFileEdges: number;
    intraFileEdges: number;
  };
  totalCounts?: {
    crossFileNodes: number;
    crossFileEdges: number;
    intraFileEdges: number;
  };
  truncated?: boolean;
  budget?: {
    summary: boolean;
    maxTokens?: number;
    maxNodes: number;
    maxEdges: number;
    omitted?: {
      crossFileNodes: number;
      crossFileEdges: number;
      intraFileEdges: number;
    };
  };
}

export interface ConventionReport {
  kind: string;
  rules: string[];
  exemplar?: {
    file: string;
    reason: string;
  };
}

export interface ContextFile {
  file: string;
  kind: string | null;
  kinds: string[];
  provenance: 'explicit_graph' | 'task_heuristic' | 'spec_reference';
  confidence: number;
  reasons: ContextReason[];
  anchors: Array<{
    symbol: string;
    kind: string;
    lines: [number, number];
  }>;
}

export interface ContextReason {
  text: string;
  provenance: 'explicit_graph' | 'task_heuristic' | 'spec_reference';
  confidence: number;
}

export interface ContextConstraint {
  kind: string;
  rule: string;
  provenance: 'mined_convention';
  advisory: true;
  confidence: number;
  frequency: number;
  total: number;
  exemplarFile: string | null;
  plugin: string | null;
}

export interface ContextExemplar {
  kind: string;
  file: string;
  plannedFile?: string;
  reason: string;
  provenance: 'structural_similarity' | 'peer_precedent' | 'spec_planned_file';
  confidence: number;
  coMentionConfidence?: number;
  shapeMatchConfidence?: number;
  nodeId: number;
}

export interface ValidationSummary {
  checkedFiles: number;
  checkedNodes: number;
  checkedRules: number;
  violations: number;
  message: string;
}

export interface ValidationRuleCheck {
  file: string;
  kind: string;
  rule: string;
  status: 'pass' | 'fail' | 'pending';
  nodesChecked: number;
  violations: number;
  confidence: number;
  frequency: number;
  total: number;
  exemplarFile: string | null;
  predictive?: boolean;
  reason?: string;
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

export interface ValidationResult {
  violations: ValidationViolation[];
  summary: ValidationSummary;
  checks: ValidationRuleCheck[];
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

// -- Indexing diagnostics --

export interface IndexingIssue {
  file: string;
  layer: 2 | 3;
  reason: string;
  relationship?: string;
  plugin?: string;
  rule?: string;
  details?: Record<string, unknown> | null;
}

export interface FileIndexDiagnostics {
  file: string;
  l2EdgesCreated: number;
  l2EdgesSkipped: number;
  l3EdgesCreated: number;
  l3EdgesSkipped: number;
  nodeCreates: number;
  metadataUpdates: number;
  queryErrors: number;
}

export interface PluginRuleDiagnostics {
  plugin: string;
  rule: string;
  filesEvaluated: number;
  matches: number;
  edgesCreated: number;
  edgesSkipped: number;
  nodesCreated: number;
  metadataUpdates: number;
  queryErrors: number;
}

export interface IndexingDiagnostics {
  totals: {
    l2EdgesCreated: number;
    l2EdgesSkipped: number;
    l3EdgesCreated: number;
    l3EdgesSkipped: number;
    nodeCreates: number;
    metadataUpdates: number;
    queryErrors: number;
    issues: number;
  };
  files: FileIndexDiagnostics[];
  pluginRules: PluginRuleDiagnostics[];
  issues: IndexingIssue[];
}

export interface WeaveStatus {
  nodeCount: number;
  edgeCount: number;
  plugins: string[];
  staleFiles: string[];
  diagnostics: IndexingDiagnostics;
}
