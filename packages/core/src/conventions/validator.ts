import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { ConventionEngine } from './engine.js';
import { isTestFilePath, toProjectRelative } from '../path-utils.js';
import type {
  Convention,
  ValidationEvidenceGap,
  ValidationRuleCheck,
  ValidationResult,
  ValidationSummary,
  ValidationViolation,
  WeaveConfig,
  WeaveNode,
} from '../types.js';
import type { GraphStore } from '../graph/store.js';

interface InertiaSharedPropsState {
  middlewareFile: string;
  sharedUserFields: Set<string>;
  frontendUsages: Map<string, Set<string>>;
}

/**
 * Validates files against derived conventions. Checks each node in the given
 * files against conventions for its kind, returning violations for any
 * high-confidence conventions (>= 0.9) that are not satisfied.
 */
export class ConventionValidator {
  private engine: ConventionEngine;
  private config: WeaveConfig;
  private store: GraphStore;
  private projectRoot: string;

  constructor(engine: ConventionEngine, config: WeaveConfig, projectRoot: string) {
    this.engine = engine;
    this.config = config;
    this.store = engine.store;
    this.projectRoot = projectRoot;
  }

  /**
   * Check files against derived conventions.
   * Returns violations for nodes that don't satisfy high-confidence conventions.
   */
  validate(filePaths: string[]): ValidationViolation[] {
    return this.validateWithSummary(filePaths).violations;
  }

  validateWithSummary(filePaths: string[], source: ValidationSummary['source'] = 'explicit_files'): ValidationResult {
    const violations: ValidationViolation[] = [];
    const checks: ValidationRuleCheck[] = [];
    const evidenceGaps: ValidationEvidenceGap[] = [];
    const semanticState = this.getInertiaSharedPropsState();
    let checkedNodes = 0;

    for (const filePath of filePaths) {
      const relativePath = toProjectRelative(this.projectRoot, filePath);
      const fileNodes = this.store.getNodesByFile(relativePath);

      if (fileNodes.length > 0) {
        checkedNodes += fileNodes.length;
        const fileViolations = this.validateNodes(relativePath, fileNodes);
        violations.push(...fileViolations);
        checks.push(...this.buildRuleChecks(relativePath, fileNodes, fileViolations));
        evidenceGaps.push(...this.buildEvidenceGaps(relativePath, fileNodes));
      } else {
        const predictive = this.validatePlannedFile(relativePath);
        violations.push(...predictive.violations);
        checks.push(...predictive.checks);
        evidenceGaps.push(...this.buildPlannedEvidenceGaps(relativePath, predictive.checks));
      }

      if (semanticState) {
        violations.push(...this.validateInertiaSharedProps(relativePath, semanticState));
      }
    }

    return {
      violations,
      summary: this.buildSummary(
        filePaths,
        checkedNodes,
        checks.length,
        violations.length,
        checks.filter(check => check.status === 'pending').length,
        evidenceGaps.length,
        source,
      ),
      checks,
      evidenceGaps,
    };
  }

  private validatePlannedFile(filePath: string): {
    violations: ValidationViolation[];
    checks: ValidationRuleCheck[];
  } {
    const kind = this.inferKindForPath(filePath);
    if (!kind) {
      return { violations: [], checks: [] };
    }

    const symbol = basename(filePath, extname(filePath));
    const node: WeaveNode = {
      id: -1,
      filePath,
      symbolName: symbol,
      kind,
      language: extname(filePath).replace('.', '') || 'unknown',
      lineStart: 1,
      lineEnd: 1,
      signature: null,
      metadata: null,
    };
    const conventions = this.engine.getConventions(kind)
      .filter(convention => convention.confidence >= 0.9);
    const checks: ValidationRuleCheck[] = [];
    const violations: ValidationViolation[] = [];

    for (const convention of conventions) {
      const pendingReason = this.predictivePendingReason(convention);
      const exemplarFile = convention.exemplarId !== null
        ? this.store.getNodeById(convention.exemplarId)?.filePath ?? null
        : null;

      if (pendingReason) {
        checks.push({
          file: filePath,
          kind,
          rule: convention.property,
          status: 'pending',
          nodesChecked: 1,
          violations: 0,
          confidence: convention.confidence,
          frequency: convention.frequency,
          total: convention.total,
          exemplarFile,
          predictive: true,
          reason: pendingReason,
        });
        continue;
      }

      const passes = this.nodeSatisfiesConvention(node, convention);
      checks.push({
        file: filePath,
        kind,
        rule: convention.property,
        status: passes ? 'pass' : 'fail',
        nodesChecked: 1,
        violations: passes ? 0 : 1,
        confidence: convention.confidence,
        frequency: convention.frequency,
        total: convention.total,
        exemplarFile,
        predictive: true,
      });

      if (!passes) {
        violations.push({
          file: filePath,
          symbol,
          kind,
          convention: convention.property,
          frequency: convention.frequency,
          total: convention.total,
          confidence: convention.confidence,
          exemplarFile,
          message: `${filePath} is planned as a ${kind} but doesn't ${convention.property}. ${convention.frequency}/${convention.total} ${kind}s do.`,
        });
      }
    }

    return { violations, checks };
  }

  private inferKindForPath(filePath: string): string | null {
    if (filePath.startsWith('app/Actions/')) return 'action';
    if (filePath.startsWith('app/Models/')) return 'model';
    if (/^app\/(?:Services|Clients|Integrations)\//.test(filePath)) return 'service';
    if (filePath.startsWith('database/migrations/')) return 'migration';
    if (filePath.startsWith('config/') && filePath.endsWith('.php')) return 'config_array';
    if (filePath.startsWith('app/Http/Requests/')) return 'form_request';
    if (isTestFilePath(filePath)) return 'test';
    if (filePath.startsWith('resources/js/types/') && /\.(?:ts|tsx|js|jsx)$/.test(filePath)) return 'type_contract';
    if (filePath.startsWith('resources/js/Pages/') && filePath.endsWith('.vue')) return 'inertia_page';
    if (filePath.startsWith('resources/js/Components/') && filePath.endsWith('.vue')) return 'component';
    if (filePath.startsWith('resources/js/composables/') && /\/use[A-Z].*\.(?:js|ts)$/.test(filePath)) return 'composable';
    return null;
  }

  private predictivePendingReason(convention: Convention): string | null {
    const type = convention.metadata?.type;
    if (type === 'structural' || type === 'edge_pattern' || type === 'relationship' || type === 'metadata') {
      return 'Requires indexed code or graph edges; validate again after creating and wiring the file.';
    }
    return null;
  }

  private buildRuleChecks(
    filePath: string,
    nodes: WeaveNode[],
    fileViolations: ValidationViolation[],
  ): ValidationRuleCheck[] {
    const checks: ValidationRuleCheck[] = [];
    const nodesByKind = new Map<string, WeaveNode[]>();
    for (const node of nodes) {
      if (node.kind === 'file') {
        continue;
      }
      const existing = nodesByKind.get(node.kind) ?? [];
      existing.push(node);
      nodesByKind.set(node.kind, existing);
    }

    for (const [kind, kindNodes] of nodesByKind.entries()) {
      const conventions = this.engine.getConventions(kind)
        .filter(convention => convention.confidence >= 0.9);

      for (const convention of conventions) {
        const matchingViolations = fileViolations.filter(violation =>
          violation.kind === kind && violation.convention === convention.property,
        );
        const exemplarFile = convention.exemplarId !== null
          ? this.store.getNodeById(convention.exemplarId)?.filePath ?? null
          : null;

        checks.push({
          file: filePath,
          kind,
          rule: convention.property,
          status: matchingViolations.length > 0 ? 'fail' : 'pass',
          nodesChecked: kindNodes.length,
          violations: matchingViolations.length,
          confidence: convention.confidence,
          frequency: convention.frequency,
          total: convention.total,
          exemplarFile,
        });
      }
    }

    return checks;
  }

  private buildEvidenceGaps(filePath: string, nodes: WeaveNode[]): ValidationEvidenceGap[] {
    const inferredKind = this.inferKindForPath(filePath);
    const indexedKinds = new Set(nodes.map(node => node.kind));
    const kindSet = new Set<string>();

    if (inferredKind) {
      if (!indexedKinds.has(inferredKind)) {
        if (inferredKind === 'inertia_page' && indexedKinds.has('component')) {
          kindSet.add('component');
          return this.evidenceGapsForKinds(filePath, kindSet);
        }
        return [this.evidenceGap(filePath, inferredKind, 'no_indexed_nodes')];
      }
      kindSet.add(inferredKind);
    } else {
      for (const node of nodes) {
        if (this.isPatternValidatedKind(node.kind)) {
          kindSet.add(node.kind);
        }
      }
    }

    if (kindSet.size === 0) {
      return [this.evidenceGap(filePath, inferredKind, inferredKind ? 'no_indexed_nodes' : 'unknown_kind')];
    }

    return this.evidenceGapsForKinds(filePath, kindSet);
  }

  private evidenceGapsForKinds(filePath: string, kindSet: Set<string>): ValidationEvidenceGap[] {
    const gaps: ValidationEvidenceGap[] = [];
    for (const kind of kindSet) {
      const conventions = this.engine.getConventions(kind);
      if (conventions.some(convention => convention.confidence >= 0.9)) {
        continue;
      }
      gaps.push(this.evidenceGap(filePath, kind, 'no_high_confidence_conventions'));
    }
    return gaps;
  }

  private isPatternValidatedKind(kind: string): boolean {
    return [
      'action',
      'component',
      'composable',
      'config_array',
      'form_request',
      'inertia_page',
      'migration',
      'model',
      'service',
      'test',
      'type_contract',
    ].includes(kind);
  }

  private buildPlannedEvidenceGaps(
    filePath: string,
    checks: ValidationRuleCheck[],
  ): ValidationEvidenceGap[] {
    if (checks.length > 0) {
      return [];
    }

    const kind = this.inferKindForPath(filePath);
    return [this.evidenceGap(filePath, kind, kind ? 'no_high_confidence_conventions' : 'unknown_kind')];
  }

  private evidenceGap(
    filePath: string,
    kind: string | null,
    reason: ValidationEvidenceGap['reason'],
  ): ValidationEvidenceGap {
    const conventions = kind ? this.engine.getConventions(kind) : [];
    const sorted = [...conventions].sort((a, b) => b.confidence - a.confidence);
    const highest = sorted[0] ?? null;
    const exemplarFile = highest?.exemplarId !== null && highest?.exemplarId !== undefined
      ? this.store.getNodeById(highest.exemplarId)?.filePath ?? null
      : null;
    const highestConfidence = highest?.confidence ?? null;
    const kindLabel = kind ?? 'unknown kind';

    let message: string;
    if (reason === 'unknown_kind') {
      message = `${filePath} does not match a known Weave file kind, so no codebase pattern checks were applied.`;
    } else if (reason === 'no_indexed_nodes') {
      message = `${filePath} looks like a ${kindLabel}, but Weave has no indexed ${kindLabel} nodes for it; validate again after indexing or pass the concrete generated file.`;
    } else {
      message = `${filePath} looks like a ${kindLabel}, but Weave has no high-confidence ${kindLabel} conventions to enforce. Treat this as an invention zone and verify against nearby code manually.`;
    }

    return {
      file: filePath,
      kind,
      reason,
      conventionsFound: conventions.length,
      highestConfidence,
      exemplarFile,
      message,
    };
  }

  private buildSummary(
    filePaths: string[],
    checkedNodes: number,
    checkedRules: number,
    violationCount: number,
    pendingCount: number = 0,
    evidenceGapCount: number = 0,
    source: ValidationSummary['source'] = 'explicit_files',
  ): ValidationSummary {
    let message: string;
    if (violationCount > 0) {
      message = `Checked ${filePaths.length} file(s) against ${checkedRules} high-confidence rule(s); found ${violationCount} violation(s).`;
    } else if (pendingCount > 0) {
      message = `Checked ${filePaths.length} file(s) against ${checkedRules} high-confidence rule(s); no failures, ${pendingCount} pending graph-dependent check(s).`;
    } else if (evidenceGapCount > 0) {
      message = `Checked ${filePaths.length} file(s) against ${checkedRules} high-confidence rule(s); no failures, but ${evidenceGapCount} file/kind(s) lacked enforceable pattern evidence.`;
    } else {
      message = `Checked ${filePaths.length} file(s) against ${checkedRules} high-confidence rule(s); all pass.`;
    }

    if (evidenceGapCount > 0 && (violationCount > 0 || pendingCount > 0)) {
      message += ` ${evidenceGapCount} file/kind(s) also lacked enforceable pattern evidence.`;
    }

    return {
      checkedFiles: filePaths.length,
      checkedNodes,
      checkedRules,
      violations: violationCount,
      evidenceGaps: evidenceGapCount,
      source,
      message,
    };
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

      case 'metadata': {
        if (!node.metadata || typeof node.metadata !== 'object') {
          return false;
        }
        const metadata = node.metadata as Record<string, unknown>;
        return metadata[meta.key as string] === meta.value;
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

  private validateInertiaSharedProps(
    filePath: string,
    state: InertiaSharedPropsState,
  ): ValidationViolation[] {
    if (filePath === state.middlewareFile) {
      return this.validateMiddlewareSharedProps(filePath, state);
    }

    const usedFields = state.frontendUsages.get(filePath);
    if (!usedFields || usedFields.size === 0) {
      return [];
    }

    const missingFields = Array.from(usedFields)
      .filter(field => !state.sharedUserFields.has(field))
      .sort();
    if (missingFields.length === 0) {
      return [];
    }

    const kind = this.primaryKindForFile(filePath) ?? 'frontend';
    return missingFields.map(field => ({
      file: filePath,
      symbol: `auth.user.${field}`,
      kind,
      convention: `shares auth.user.${field}`,
      frequency: 1,
      total: 1,
      confidence: 0.98,
      exemplarFile: state.middlewareFile,
      message:
        `${filePath} reads auth.user.${field} from Inertia page props, but ` +
        `${state.middlewareFile} does not share that field in HandleInertiaRequests::share().`,
    }));
  }

  private validateMiddlewareSharedProps(
    filePath: string,
    state: InertiaSharedPropsState,
  ): ValidationViolation[] {
    const violations: ValidationViolation[] = [];

    for (const [consumerFile, usedFields] of state.frontendUsages.entries()) {
      const missingFields = Array.from(usedFields)
        .filter(field => !state.sharedUserFields.has(field))
        .sort();

      for (const field of missingFields) {
        violations.push({
          file: filePath,
          symbol: 'HandleInertiaRequests::share',
          kind: 'middleware',
          convention: `shares auth.user.${field}`,
          frequency: 1,
          total: 1,
          confidence: 0.98,
          exemplarFile: consumerFile,
          message:
            `HandleInertiaRequests::share() does not expose auth.user.${field}, ` +
            `but ${consumerFile} reads that field from Inertia page props.`,
        });
      }
    }

    return violations;
  }

  private getInertiaSharedPropsState(): InertiaSharedPropsState | null {
    const middlewareFile = this.findHandleInertiaRequestsFile();
    if (!middlewareFile) {
      return null;
    }

    const middlewareContent = this.safeReadProjectFile(middlewareFile);
    if (!middlewareContent) {
      return null;
    }

    const sharedUserFields = this.extractSharedAuthUserFields(middlewareContent);
    const frontendUsages = this.collectFrontendAuthUserUsages();

    if (sharedUserFields.size === 0 && frontendUsages.size === 0) {
      return null;
    }

    return {
      middlewareFile,
      sharedUserFields,
      frontendUsages,
    };
  }

  private findHandleInertiaRequestsFile(): string | null {
    const primary = 'app/Http/Middleware/HandleInertiaRequests.php';
    if (existsSync(join(this.projectRoot, primary))) {
      return primary;
    }

    const candidate = this.store.getAllNodes()
      .map(node => node.filePath)
      .find(filePath => filePath.endsWith('/HandleInertiaRequests.php'));

    return candidate ?? null;
  }

  private collectFrontendAuthUserUsages(): Map<string, Set<string>> {
    const usages = new Map<string, Set<string>>();
    const frontendFiles = new Set(
      this.store.getAllNodes()
        .map(node => node.filePath)
        .filter(filePath =>
          filePath.startsWith('resources/js/')
          && ['.js', '.ts', '.vue'].includes(extname(filePath)),
        ),
    );

    for (const filePath of frontendFiles) {
      const content = this.safeReadProjectFile(filePath);
      if (!content) continue;

      const fields = this.extractAuthUserFieldsFromFrontend(content, filePath);
      if (fields.size > 0) {
        usages.set(filePath, fields);
      }
    }

    return usages;
  }

  private extractSharedAuthUserFields(source: string): Set<string> {
    const userArrayMatch = /['"]user['"]\s*=>\s*\[/g.exec(source);
    if (!userArrayMatch) {
      return new Set();
    }

    const bracketIndex = source.indexOf('[', userArrayMatch.index);
    const block = bracketIndex >= 0 ? this.extractBracketBlock(source, bracketIndex, '[', ']') : null;
    if (!block) {
      return new Set();
    }

    return this.extractTopLevelPhpArrayKeys(block);
  }

  private extractAuthUserFieldsFromFrontend(source: string, filePath: string): Set<string> {
    const scriptSource = filePath.endsWith('.vue')
      ? this.extractVueScriptSource(source)
      : source;

    const fields = new Set<string>();
    const pageVars = this.extractUsePageVariables(scriptSource);
    const pageSources = ['usePage\\(\\)', ...Array.from(pageVars).map(name => this.escapeRegex(name))];

    for (const sourceToken of pageSources) {
      const userExpr = `${sourceToken}\\.props(?:\\?\\.|\\.)auth(?:\\?\\.|\\.)user\\b`;
      const terminalUserExpr = `${userExpr}(?!\\s*(?:\\?\\.|\\.))`;

      for (const field of this.collectRegexMatches(
        scriptSource,
        new RegExp(`${userExpr}(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)\\b`, 'g'),
      )) {
        fields.add(field);
      }

      for (const alias of this.collectRegexMatches(
        scriptSource,
        new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${terminalUserExpr}\\b`, 'g'),
      )) {
        for (const field of this.collectVariableFieldReads(scriptSource, alias)) {
          fields.add(field);
        }
      }

      for (const fnName of this.collectRegexMatches(
        scriptSource,
        new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\(\\s*${terminalUserExpr}\\s*\\)`, 'g'),
      )) {
        for (const field of this.collectFunctionParamFieldReads(scriptSource, fnName, 0)) {
          fields.add(field);
        }
      }
    }

    return fields;
  }

  private collectFunctionParamFieldReads(source: string, fnName: string, paramIndex: number): Set<string> {
    const declaration = this.findNamedFunctionDeclaration(source, fnName);
    if (!declaration) {
      return new Set();
    }

    const params = declaration.params
      .split(',')
      .map(param => param.trim())
      .filter(Boolean)
      .map(param => param.replace(/=.*/, '').trim());
    const paramName = params[paramIndex];
    if (!paramName) {
      return new Set();
    }

    return this.collectVariableFieldReads(declaration.body, paramName);
  }

  private findNamedFunctionDeclaration(
    source: string,
    fnName: string,
  ): { params: string; body: string } | null {
    const escapedName = this.escapeRegex(fnName);
    const patterns = [
      new RegExp(`function\\s+${escapedName}\\s*\\(([^)]*)\\)\\s*\\{`, 'g'),
      new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*\\(([^)]*)\\)\\s*=>\\s*\\{`, 'g'),
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (!match) continue;

      const bodyStart = source.indexOf('{', match.index);
      if (bodyStart < 0) continue;

      const body = this.extractBracketBlock(source, bodyStart, '{', '}');
      if (body === null) continue;

      return {
        params: match[1] ?? '',
        body,
      };
    }

    return null;
  }

  private collectVariableFieldReads(source: string, variableName: string): Set<string> {
    return new Set(this.collectRegexMatches(
      source,
      new RegExp(`\\b${this.escapeRegex(variableName)}(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)\\b`, 'g'),
    ));
  }

  private extractUsePageVariables(source: string): Set<string> {
    return new Set(this.collectRegexMatches(
      source,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*usePage\(\s*\)/g,
    ));
  }

  private extractVueScriptSource(source: string): string {
    const matches = Array.from(source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g));
    if (matches.length === 0) {
      return source;
    }

    return matches.map(match => match[1]).join('\n');
  }

  private extractTopLevelPhpArrayKeys(block: string): Set<string> {
    const keys = new Set<string>();
    let depth = 1;
    let index = 0;

    while (index < block.length) {
      const char = block[index];

      if (char === '[') {
        depth += 1;
        index += 1;
        continue;
      }

      if (char === ']') {
        depth -= 1;
        index += 1;
        continue;
      }

      if ((char === '\'' || char === '"') && depth === 1) {
        const quote = char;
        const end = this.findStringEnd(block, index + 1, quote);
        if (end < 0) break;

        const key = block.slice(index + 1, end);
        let lookahead = end + 1;
        while (lookahead < block.length && /\s/.test(block[lookahead])) {
          lookahead += 1;
        }

        if (block.slice(lookahead, lookahead + 2) === '=>') {
          keys.add(key);
        }

        index = end + 1;
        continue;
      }

      index += 1;
    }

    return keys;
  }

  private extractBracketBlock(
    source: string,
    startIndex: number,
    open: string,
    close: string,
  ): string | null {
    let depth = 0;

    for (let index = startIndex; index < source.length; index += 1) {
      const char = source[index];

      if (char === '\'' || char === '"') {
        const end = this.findStringEnd(source, index + 1, char);
        if (end < 0) {
          return null;
        }
        index = end;
        continue;
      }

      if (char === open) {
        depth += 1;
        continue;
      }

      if (char === close) {
        depth -= 1;
        if (depth === 0) {
          return source.slice(startIndex + 1, index);
        }
      }
    }

    return null;
  }

  private findStringEnd(source: string, startIndex: number, quote: string): number {
    for (let index = startIndex; index < source.length; index += 1) {
      if (source[index] === '\\') {
        index += 1;
        continue;
      }
      if (source[index] === quote) {
        return index;
      }
    }
    return -1;
  }

  private collectRegexMatches(source: string, pattern: RegExp): string[] {
    const matches: string[] = [];
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        matches.push(match[1]);
      }
    }
    return matches;
  }

  private primaryKindForFile(filePath: string): string | null {
    const nodes = this.store.getNodesByFile(filePath)
      .filter(node => node.kind !== 'file')
      .sort((a, b) => a.lineStart - b.lineStart);

    return nodes[0]?.kind ?? null;
  }

  private safeReadProjectFile(filePath: string): string | null {
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

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
