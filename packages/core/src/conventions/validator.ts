import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ConventionEngine } from './engine.js';
import { toProjectRelative } from '../path-utils.js';
import type {
  Convention,
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
    const violations: ValidationViolation[] = [];
    const semanticState = this.getInertiaSharedPropsState();

    for (const filePath of filePaths) {
      const relativePath = toProjectRelative(this.projectRoot, filePath);
      const fileNodes = this.store.getNodesByFile(relativePath);

      if (fileNodes.length > 0) {
        const fileViolations = this.validateNodes(relativePath, fileNodes);
        violations.push(...fileViolations);
      }

      if (semanticState) {
        violations.push(...this.validateInertiaSharedProps(relativePath, semanticState));
      }
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
