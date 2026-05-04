import type Parser from 'tree-sitter';
import type { WeaveNode, WeaveEdge } from '../types.js';
import type { TreeSitterParser } from './parser.js';
import { basename, extname } from 'path';

interface ExtractionResult {
  nodes: Partial<WeaveNode>[];
  edges: Partial<WeaveEdge>[];
}

/**
 * Extracts L1 symbols (nodes) and L2 edges (imports, calls, extends) from source files.
 * Returns partial WeaveNode objects without id — the store assigns ids on insert.
 */
export class SymbolExtractor {
  constructor(private parser: TreeSitterParser) {}

  /**
   * Extract L1 symbols and L2 edges from a file.
   * Returns partial WeaveNode objects (no id).
   */
  extract(filePath: string): Partial<WeaveNode>[] {
    const result = this.extractFull(filePath);
    return result.nodes;
  }

  /**
   * Full extraction returning both nodes and edges.
   */
  extractFull(filePath: string): ExtractionResult {
    const language = this.parser.getLanguage(filePath);

    if (language === 'vue') {
      return this.extractVue(filePath);
    }

    const tree = this.parser.parse(filePath);

    switch (language) {
      case 'php':
        return this.extractPhp(filePath, tree);
      case 'typescript':
      case 'tsx':
      case 'javascript':
        return this.extractTypeScript(filePath, tree, language);
      case 'python':
        return this.extractPython(filePath, tree);
      default:
        return { nodes: [], edges: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // PHP extraction
  // ---------------------------------------------------------------------------

  private extractPhp(filePath: string, tree: Parser.Tree): ExtractionResult {
    const nodes: Partial<WeaveNode>[] = [];
    const edges: Partial<WeaveEdge>[] = [];
    const root = tree.rootNode;
    const source = this.parser.readSource(filePath);

    let namespace = '';

    // Walk top-level children
    for (const child of root.children) {
      switch (child.type) {
        case 'namespace_definition': {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            namespace = nameNode.text;
          }
          // Extract from namespace body
          const body = child.childForFieldName('body');
          if (body) {
            this.extractPhpBody(filePath, body, source, namespace, nodes, edges);
          }
          break;
        }
        case 'function_definition':
          this.extractPhpFunction(filePath, child, source, nodes);
          break;
        case 'class_declaration':
          this.extractPhpClass(filePath, child, source, namespace, nodes, edges);
          break;
        case 'use_declaration':
        case 'namespace_use_declaration':
          this.extractPhpUse(filePath, child, edges);
          break;
        default:
          break;
      }
    }

    return { nodes, edges };
  }

  private extractPhpBody(
    filePath: string,
    body: Parser.SyntaxNode,
    source: string,
    namespace: string,
    nodes: Partial<WeaveNode>[],
    edges: Partial<WeaveEdge>[],
  ): void {
    for (const child of body.children) {
      switch (child.type) {
        case 'function_definition':
          this.extractPhpFunction(filePath, child, source, nodes);
          break;
        case 'class_declaration':
          this.extractPhpClass(filePath, child, source, namespace, nodes, edges);
          break;
        case 'use_declaration':
        case 'namespace_use_declaration':
          this.extractPhpUse(filePath, child, edges);
          break;
        default:
          break;
      }
    }
  }

  private extractPhpFunction(
    filePath: string,
    node: Parser.SyntaxNode,
    source: string,
    nodes: Partial<WeaveNode>[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    nodes.push({
      filePath,
      symbolName: nameNode.text,
      kind: 'function',
      language: 'php',
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: this.extractSignatureLine(source, node),
      metadata: null,
    });
  }

  private extractPhpClass(
    filePath: string,
    node: Parser.SyntaxNode,
    source: string,
    namespace: string,
    nodes: Partial<WeaveNode>[],
    edges: Partial<WeaveEdge>[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const className = nameNode.text;
    const methods: string[] = [];

    // Check for extends
    const baseClause = node.childForFieldName('base_clause')
      ?? node.children.find(child => child.type === 'base_clause');
    if (baseClause) {
      const baseName = baseClause.children.find(c => c.type === 'name' || c.type === 'qualified_name');
      if (baseName) {
        edges.push({
          sourceId: 0, // placeholder — resolved by store via symbol name
          targetId: 0,
          relationship: 'extends',
          layer: 2,
          convention: null,
          metadata: {
            sourceSymbol: className,
            targetSymbol: baseName.text,
            sourceFile: filePath,
          },
          confidence: 1.0,
        });
      }
    }

    // Extract methods within the class body
    const body = node.childForFieldName('body');
    if (body) {
      for (const member of body.children) {
        if (member.type === 'method_declaration') {
          const methodName = member.childForFieldName('name');
          if (methodName) {
            methods.push(methodName.text);
            nodes.push({
              filePath,
              symbolName: `${className}::${methodName.text}`,
              kind: 'method',
              language: 'php',
              lineStart: member.startPosition.row + 1,
              lineEnd: member.endPosition.row + 1,
              signature: this.extractSignatureLine(source, member),
              metadata: { className },
            });

            // Extract call edges from method body
            this.extractCallEdges(filePath, `${className}::${methodName.text}`, member, edges);
          }
        }
      }
    }

    nodes.push({
      filePath,
      symbolName: className,
      kind: 'class',
      language: 'php',
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: this.extractSignatureLine(source, node),
      metadata: {
        namespace: namespace || null,
        methods,
      },
    });
  }

  private extractPhpUse(
    filePath: string,
    node: Parser.SyntaxNode,
    edges: Partial<WeaveEdge>[],
  ): void {
    // use_declaration can contain one or more use_clause children
    for (const child of node.children) {
      if (
        child.type === 'use_clause'
        || child.type === 'namespace_use_clause'
        || child.type === 'qualified_name'
        || child.type === 'name'
      ) {
        const fullName = child.text;
        edges.push({
          sourceId: 0,
          targetId: 0,
          relationship: 'imports',
          layer: 2,
          convention: null,
          metadata: {
            sourceFile: filePath,
            importedSymbol: fullName,
          },
          confidence: 1.0,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TypeScript / JavaScript extraction
  // ---------------------------------------------------------------------------

  private extractTypeScript(
    filePath: string,
    tree: Parser.Tree,
    language: string,
  ): ExtractionResult {
    const nodes: Partial<WeaveNode>[] = [];
    const edges: Partial<WeaveEdge>[] = [];
    const root = tree.rootNode;
    const source = this.parser.readSource(filePath);
    const lang = language === 'tsx' ? 'typescript' : language;

    for (const child of root.children) {
      switch (child.type) {
        case 'function_declaration':
          this.extractTsFunction(filePath, child, source, lang, nodes, edges);
          break;

        case 'class_declaration':
          this.extractTsClass(filePath, child, source, lang, nodes, edges);
          break;

        case 'import_statement':
          this.extractTsImport(filePath, child, edges);
          break;

        case 'export_statement':
          this.extractTsExport(filePath, child, source, lang, nodes, edges);
          break;

        case 'lexical_declaration':
          // Arrow functions and function expressions assigned to const
          this.extractTsConstFunctions(filePath, child, source, lang, nodes, edges);
          break;

        case 'expression_statement':
          // Module-level exports like module.exports = ...
          break;

        default:
          break;
      }
    }

    return { nodes, edges };
  }

  private extractTsFunction(
    filePath: string,
    node: Parser.SyntaxNode,
    source: string,
    language: string,
    nodes: Partial<WeaveNode>[],
    edges: Partial<WeaveEdge>[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const kind = nameNode.text.match(/^use[A-Z]/) ? 'composable' : 'function';

    nodes.push({
      filePath,
      symbolName: nameNode.text,
      kind,
      language,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: this.extractSignatureLine(source, node),
      metadata: null,
    });

    this.extractCallEdges(filePath, nameNode.text, node, edges);
  }

  private extractTsClass(
    filePath: string,
    node: Parser.SyntaxNode,
    source: string,
    language: string,
    nodes: Partial<WeaveNode>[],
    edges: Partial<WeaveEdge>[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const className = nameNode.text;
    const methods: string[] = [];
    let foundExtends = false;

    // Check heritage (extends) — field-based access
    const heritage = node.childForFieldName('heritage');
    if (heritage) {
      for (const clause of heritage.children) {
        if (clause.type === 'extends_clause') {
          const superclass = clause.children.find(c =>
            c.type === 'identifier' || c.type === 'member_expression',
          );
          if (superclass) {
            foundExtends = true;
            edges.push({
              sourceId: 0,
              targetId: 0,
              relationship: 'extends',
              layer: 2,
              convention: null,
              metadata: {
                sourceSymbol: className,
                targetSymbol: superclass.text,
                sourceFile: filePath,
              },
              confidence: 1.0,
            });
          }
        }
      }
    }

    // Fallback: look for extends in class_heritage child type (some grammar versions)
    if (!foundExtends) {
      this.findTsExtends(node, className, filePath, edges);
    }

    // Extract methods from class body
    const body = node.childForFieldName('body');
    if (body) {
      for (const member of body.children) {
        if (member.type === 'method_definition' || member.type === 'public_field_definition') {
          const methodName = member.childForFieldName('name');
          if (methodName && member.type === 'method_definition') {
            methods.push(methodName.text);
            nodes.push({
              filePath,
              symbolName: `${className}.${methodName.text}`,
              kind: 'method',
              language,
              lineStart: member.startPosition.row + 1,
              lineEnd: member.endPosition.row + 1,
              signature: this.extractSignatureLine(source, member),
              metadata: { className },
            });

            this.extractCallEdges(filePath, `${className}.${methodName.text}`, member, edges);
          }
        }
      }
    }

    nodes.push({
      filePath,
      symbolName: className,
      kind: 'class',
      language,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: this.extractSignatureLine(source, node),
      metadata: { methods },
    });
  }

  private findTsExtends(
    classNode: Parser.SyntaxNode,
    className: string,
    filePath: string,
    edges: Partial<WeaveEdge>[],
  ): void {
    // Some tree-sitter-typescript versions place extends as class_heritage
    for (const child of classNode.children) {
      if (child.type === 'class_heritage') {
        for (const clause of child.children) {
          if (clause.type === 'extends_clause') {
            const valueNode = clause.children.find(c => c.type === 'identifier');
            if (valueNode) {
              // Avoid duplicate if already added via heritage field
              edges.push({
                sourceId: 0,
                targetId: 0,
                relationship: 'extends',
                layer: 2,
                convention: null,
                metadata: {
                  sourceSymbol: className,
                  targetSymbol: valueNode.text,
                  sourceFile: filePath,
                },
                confidence: 1.0,
              });
            }
          }
        }
      }
    }
  }

  private extractTsImport(
    filePath: string,
    node: Parser.SyntaxNode,
    edges: Partial<WeaveEdge>[],
  ): void {
    // import { X, Y } from 'module'
    // import X from 'module'
    // import * as X from 'module'
    const sourceNode = node.childForFieldName('source');
    if (!sourceNode) return;

    const moduleSpecifier = this.stripQuotes(sourceNode.text);
    const importedNames: string[] = [];

    // Collect imported identifiers
    for (const child of node.children) {
      if (child.type === 'import_clause') {
        this.collectIdentifiers(child, importedNames);
      }
      // Named imports can also appear at top level of import_statement
      if (child.type === 'named_imports' || child.type === 'import_specifier') {
        this.collectIdentifiers(child, importedNames);
      }
      if (child.type === 'identifier') {
        importedNames.push(child.text);
      }
    }

    edges.push({
      sourceId: 0,
      targetId: 0,
      relationship: 'imports',
      layer: 2,
      convention: null,
      metadata: {
        sourceFile: filePath,
        moduleSpecifier,
        importedNames,
      },
      confidence: 1.0,
    });
  }

  private extractTsExport(
    filePath: string,
    node: Parser.SyntaxNode,
    source: string,
    language: string,
    nodes: Partial<WeaveNode>[],
    edges: Partial<WeaveEdge>[],
  ): void {
    const exportedNames: string[] = [];

    for (const child of node.children) {
      switch (child.type) {
        case 'function_declaration':
          this.extractTsFunction(filePath, child, source, language, nodes, edges);
          break;

        case 'class_declaration':
          this.extractTsClass(filePath, child, source, language, nodes, edges);
          break;

        case 'lexical_declaration':
          this.extractTsConstFunctions(filePath, child, source, language, nodes, edges);
          break;

        case 'export_clause': {
          // export { X, Y } or export { X as Y }
          for (const spec of child.children) {
            if (spec.type === 'export_specifier') {
              const nameNode = spec.childForFieldName('name');
              if (nameNode) exportedNames.push(nameNode.text);
            }
          }
          break;
        }

        default:
          break;
      }
    }

    // Mark exported symbols in metadata
    if (exportedNames.length > 0) {
      nodes.push({
        filePath,
        symbolName: '__exports__',
        kind: 'export',
        language,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        signature: null,
        metadata: { exportedNames },
      });
    }
  }

  private extractTsConstFunctions(
    filePath: string,
    node: Parser.SyntaxNode,
    source: string,
    language: string,
    nodes: Partial<WeaveNode>[],
    edges: Partial<WeaveEdge>[],
  ): void {
    // const foo = () => {} or const foo = function() {}
    for (const declarator of node.children) {
      if (declarator.type !== 'variable_declarator') continue;

      const nameNode = declarator.childForFieldName('name');
      const valueNode = declarator.childForFieldName('value');
      if (!nameNode || !valueNode) continue;

      const isFunction =
        valueNode.type === 'arrow_function' ||
        valueNode.type === 'function_expression' ||
        valueNode.type === 'function';

      if (!isFunction) continue;

      const symbolName = nameNode.text;
      const kind = symbolName.match(/^use[A-Z]/) ? 'composable' : 'function';

      nodes.push({
        filePath,
        symbolName,
        kind,
        language,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        signature: this.extractSignatureLine(source, node),
        metadata: null,
      });

      this.extractCallEdges(filePath, symbolName, valueNode, edges);
    }
  }

  // ---------------------------------------------------------------------------
  // Python extraction
  // ---------------------------------------------------------------------------

  private extractPython(filePath: string, tree: Parser.Tree): ExtractionResult {
    const nodes: Partial<WeaveNode>[] = [];
    const edges: Partial<WeaveEdge>[] = [];
    const root = tree.rootNode;
    const source = this.parser.readSource(filePath);

    for (const child of root.children) {
      switch (child.type) {
        case 'function_definition':
          this.extractPythonFunction(filePath, child, source, nodes, edges);
          break;

        case 'class_definition':
          this.extractPythonClass(filePath, child, source, nodes, edges);
          break;

        case 'import_statement':
          this.extractPythonImport(filePath, child, edges);
          break;

        case 'import_from_statement':
          this.extractPythonFromImport(filePath, child, edges);
          break;

        case 'decorated_definition': {
          // Unwrap decorator to get the actual definition
          const inner = child.children.find(
            c => c.type === 'function_definition' || c.type === 'class_definition',
          );
          if (inner?.type === 'function_definition') {
            this.extractPythonFunction(filePath, inner, source, nodes, edges);
          } else if (inner?.type === 'class_definition') {
            this.extractPythonClass(filePath, inner, source, nodes, edges);
          }
          break;
        }

        default:
          break;
      }
    }

    return { nodes, edges };
  }

  private extractPythonFunction(
    filePath: string,
    node: Parser.SyntaxNode,
    source: string,
    nodes: Partial<WeaveNode>[],
    edges: Partial<WeaveEdge>[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    nodes.push({
      filePath,
      symbolName: nameNode.text,
      kind: 'function',
      language: 'python',
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: this.extractSignatureLine(source, node),
      metadata: null,
    });

    this.extractCallEdges(filePath, nameNode.text, node, edges);
  }

  private extractPythonClass(
    filePath: string,
    node: Parser.SyntaxNode,
    source: string,
    nodes: Partial<WeaveNode>[],
    edges: Partial<WeaveEdge>[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const className = nameNode.text;
    const methods: string[] = [];

    // Check superclasses
    const superclasses = node.childForFieldName('superclasses');
    if (superclasses) {
      for (const arg of superclasses.children) {
        if (arg.type === 'identifier') {
          edges.push({
            sourceId: 0,
            targetId: 0,
            relationship: 'extends',
            layer: 2,
            convention: null,
            metadata: {
              sourceSymbol: className,
              targetSymbol: arg.text,
              sourceFile: filePath,
            },
            confidence: 1.0,
          });
        }
        // Also handle dotted names like module.ClassName
        if (arg.type === 'attribute') {
          edges.push({
            sourceId: 0,
            targetId: 0,
            relationship: 'extends',
            layer: 2,
            convention: null,
            metadata: {
              sourceSymbol: className,
              targetSymbol: arg.text,
              sourceFile: filePath,
            },
            confidence: 1.0,
          });
        }
      }
    }

    // Extract methods from class body
    const body = node.childForFieldName('body');
    if (body) {
      for (const member of body.children) {
        if (member.type === 'function_definition') {
          const methodName = member.childForFieldName('name');
          if (methodName) {
            methods.push(methodName.text);
            nodes.push({
              filePath,
              symbolName: `${className}.${methodName.text}`,
              kind: 'method',
              language: 'python',
              lineStart: member.startPosition.row + 1,
              lineEnd: member.endPosition.row + 1,
              signature: this.extractSignatureLine(source, member),
              metadata: { className },
            });

            this.extractCallEdges(filePath, `${className}.${methodName.text}`, member, edges);
          }
        }
        // Handle decorated methods
        if (member.type === 'decorated_definition') {
          const inner = member.children.find(c => c.type === 'function_definition');
          if (inner) {
            const methodName = inner.childForFieldName('name');
            if (methodName) {
              methods.push(methodName.text);
              nodes.push({
                filePath,
                symbolName: `${className}.${methodName.text}`,
                kind: 'method',
                language: 'python',
                lineStart: inner.startPosition.row + 1,
                lineEnd: inner.endPosition.row + 1,
                signature: this.extractSignatureLine(source, inner),
                metadata: { className },
              });

              this.extractCallEdges(filePath, `${className}.${methodName.text}`, inner, edges);
            }
          }
        }
      }
    }

    nodes.push({
      filePath,
      symbolName: className,
      kind: 'class',
      language: 'python',
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: this.extractSignatureLine(source, node),
      metadata: { methods },
    });
  }

  private extractPythonImport(
    filePath: string,
    node: Parser.SyntaxNode,
    edges: Partial<WeaveEdge>[],
  ): void {
    // import X, import X.Y
    const importedNames: string[] = [];
    for (const child of node.children) {
      if (child.type === 'dotted_name') {
        importedNames.push(child.text);
      }
      if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) importedNames.push(nameNode.text);
      }
    }

    if (importedNames.length > 0) {
      edges.push({
        sourceId: 0,
        targetId: 0,
        relationship: 'imports',
        layer: 2,
        convention: null,
        metadata: {
          sourceFile: filePath,
          importedNames,
        },
        confidence: 1.0,
      });
    }
  }

  private extractPythonFromImport(
    filePath: string,
    node: Parser.SyntaxNode,
    edges: Partial<WeaveEdge>[],
  ): void {
    // from X import Y, Z
    const moduleNode = node.childForFieldName('module_name');
    const moduleName = moduleNode?.text ?? '';
    const importedNames: string[] = [];

    for (const child of node.children) {
      if (child.type === 'dotted_name' && child !== moduleNode) {
        importedNames.push(child.text);
      }
      if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) importedNames.push(nameNode.text);
      }
      if (child.type === 'import_list') {
        for (const item of child.children) {
          if (item.type === 'dotted_name' || item.type === 'identifier') {
            importedNames.push(item.text);
          }
        }
      }
    }

    edges.push({
      sourceId: 0,
      targetId: 0,
      relationship: 'imports',
      layer: 2,
      convention: null,
      metadata: {
        sourceFile: filePath,
        moduleSpecifier: moduleName,
        importedNames,
      },
      confidence: 1.0,
    });
  }

  // ---------------------------------------------------------------------------
  // Vue SFC extraction
  // ---------------------------------------------------------------------------

  private extractVue(filePath: string): ExtractionResult {
    const nodes: Partial<WeaveNode>[] = [];
    const edges: Partial<WeaveEdge>[] = [];
    const source = this.parser.readSource(filePath);

    // Derive component name from filename: BattleGrid.vue → BattleGrid
    const componentName = basename(filePath, extname(filePath));

    // Add a component node for the whole SFC
    nodes.push({
      filePath,
      symbolName: componentName,
      kind: 'component',
      language: 'vue',
      lineStart: 1,
      lineEnd: source.split('\n').length,
      signature: null,
      metadata: null,
    });

    // Extract the <script setup> or <script> block content and parse as TypeScript
    const scriptContent = this.extractScriptBlock(source);
    if (scriptContent) {
      const scriptTree = this.parser.parseString(scriptContent.text, 'typescript');
      const scriptResult = this.extractTypeScript(filePath, scriptTree, 'typescript');

      // Offset line numbers by the script block's starting line
      for (const node of scriptResult.nodes) {
        if (node.lineStart !== undefined) {
          node.lineStart += scriptContent.startLine;
        }
        if (node.lineEnd !== undefined) {
          node.lineEnd += scriptContent.startLine;
        }
        node.language = 'vue';
      }

      nodes.push(...scriptResult.nodes);
      edges.push(...scriptResult.edges);
    }

    return { nodes, edges };
  }

  private extractScriptBlock(source: string): { text: string; startLine: number } | null {
    const lines = source.split('\n');

    // Prefer <script setup> over <script>
    let inScript = false;
    let isSetupScript = false;
    let startLine = 0;
    const scriptLines: string[] = [];
    let bestMatch: { text: string; startLine: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!inScript) {
        // Match <script setup ...> or <script ...>
        const scriptMatch = trimmed.match(/^<script\b([^>]*)>/);
        if (scriptMatch) {
          inScript = true;
          isSetupScript = scriptMatch[1].includes('setup');
          startLine = i; // 0-indexed; we add 1 when creating nodes
          scriptLines.length = 0;
          continue;
        }
      } else {
        if (trimmed === '</script>') {
          inScript = false;
          const result = { text: scriptLines.join('\n'), startLine };
          // If this is a setup script, prefer it
          if (isSetupScript) {
            return result;
          }
          // Otherwise store as fallback
          bestMatch = result;
        } else {
          scriptLines.push(line);
        }
      }
    }

    return bestMatch;
  }

  // ---------------------------------------------------------------------------
  // Shared utilities
  // ---------------------------------------------------------------------------

  /**
   * Extract call edges from a function/method body.
   * Finds call_expression nodes and creates L2 call edges.
   */
  private extractCallEdges(
    filePath: string,
    callerName: string,
    node: Parser.SyntaxNode,
    edges: Partial<WeaveEdge>[],
  ): void {
    this.walkNode(node, (child) => {
      if (
        child.type === 'call_expression'
        || child.type === 'function_call_expression'
        || child.type === 'member_call_expression'
        || child.type === 'scoped_call_expression'
      ) {
        const callee = child.type === 'member_call_expression' || child.type === 'scoped_call_expression'
          ? child
          : child.childForFieldName('function') ?? child.childForFieldName('name');
        if (callee) {
          const calleeName = this.resolveCalleeName(callee);
          if (calleeName && calleeName !== callerName) {
            edges.push({
              sourceId: 0,
              targetId: 0,
              relationship: 'calls',
              layer: 2,
              convention: null,
              metadata: {
                sourceSymbol: callerName,
                targetSymbol: calleeName,
                sourceFile: filePath,
              },
              confidence: 1.0,
            });
          }
        }
      }
    });
  }

  /**
   * Resolve a callee node to a name string.
   * Handles identifiers, member expressions, and scoped calls.
   */
  private resolveCalleeName(node: Parser.SyntaxNode): string | null {
    switch (node.type) {
      case 'identifier':
      case 'name':
        return node.text;
      case 'member_expression':
      case 'member_call_expression': {
        // obj.method → "obj.method"
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('name') ?? node.childForFieldName('property');
        if (obj && prop) {
          return `${obj.text}.${prop.text}`;
        }
        return null;
      }
      case 'scoped_call_expression': {
        const scope = node.childForFieldName('scope');
        const name = node.childForFieldName('name');
        if (scope && name) return `${scope.text}::${name.text}`;
        return null;
      }
      default:
        return node.text || null;
    }
  }

  /**
   * Walk all descendant nodes, invoking callback on each.
   */
  private walkNode(node: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void): void {
    callback(node);
    for (const child of node.children) {
      this.walkNode(child, callback);
    }
  }

  /**
   * Extract the first line of a node as its signature.
   * For classes, takes the declaration line up to the opening brace.
   * For functions, takes the line with the function signature.
   */
  private extractSignatureLine(source: string, node: Parser.SyntaxNode): string {
    const lines = source.split('\n');
    const startLine = node.startPosition.row;

    // Take the first line, trimmed
    const firstLine = (lines[startLine] ?? '').trim();

    // For multi-line signatures, try to capture up to the opening brace or colon
    if (firstLine.includes('{') || firstLine.includes(':')) {
      return firstLine;
    }

    // If the first line doesn't have a brace, look for it in the next few lines
    const sigLines: string[] = [firstLine];
    for (let i = startLine + 1; i < Math.min(startLine + 5, lines.length); i++) {
      const line = lines[i].trim();
      sigLines.push(line);
      if (line.includes('{') || line.includes(':') || line === '') {
        break;
      }
    }

    return sigLines.join(' ');
  }

  /**
   * Collect identifiers from an AST subtree.
   */
  private collectIdentifiers(node: Parser.SyntaxNode, names: string[]): void {
    if (node.type === 'identifier') {
      names.push(node.text);
      return;
    }
    for (const child of node.children) {
      this.collectIdentifiers(child, names);
    }
  }

  /**
   * Strip surrounding quotes from a string literal.
   */
  private stripQuotes(text: string): string {
    if (
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"'))
    ) {
      return text.slice(1, -1);
    }
    return text;
  }
}
