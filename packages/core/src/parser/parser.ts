import { createRequire } from 'node:module';
import Parser from 'tree-sitter';
import { readFileSync, statSync } from 'fs';
import { extname } from 'path';

// Native addons need require() even in ESM
const require = createRequire(import.meta.url);

interface CacheEntry {
  tree: Parser.Tree;
  mtime: number;
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.php': 'php',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.vue': 'vue',
  '.py': 'python',
};

/**
 * Wraps tree-sitter for multi-language AST parsing.
 * Lazily loads language grammars on first use and caches parsed trees
 * by file path + mtime to avoid re-parsing unchanged files.
 */
export class TreeSitterParser {
  private parser: Parser;
  private grammars: Map<string, Parser.Language> = new Map();
  private cache: Map<string, CacheEntry> = new Map();

  constructor() {
    this.parser = new Parser();
  }

  /**
   * Detect language from file extension.
   * Returns a canonical language string.
   */
  getLanguage(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const lang = EXTENSION_LANGUAGE_MAP[ext];
    if (!lang) {
      throw new Error(`Unsupported file extension: ${ext} (file: ${filePath})`);
    }
    return lang;
  }

  /**
   * Parse a file and return the AST tree.
   * Results are cached by file path + mtime.
   */
  parse(filePath: string): Parser.Tree {
    const stat = statSync(filePath);
    const mtime = stat.mtimeMs;
    const language = this.getLanguage(filePath);
    const grammar = this.loadGrammar(language);

    const cached = this.cache.get(filePath);
    if (cached && cached.mtime === mtime) {
      this.parser.setLanguage(grammar);
      return cached.tree;
    }

    this.parser.setLanguage(grammar);

    const source = readFileSync(filePath, 'utf-8');
    const tree = this.parser.parse(source);

    this.cache.set(filePath, { tree, mtime });
    return tree;
  }

  /**
   * Parse a raw source string with a given language.
   * Useful for extracting sub-blocks (e.g., script content from Vue SFCs).
   */
  parseString(source: string, language: string): Parser.Tree {
    const grammar = this.loadGrammar(language);
    this.parser.setLanguage(grammar);
    return this.parser.parse(source);
  }

  /**
   * Run a tree-sitter query pattern against a parsed tree.
   */
  query(tree: Parser.Tree, queryString: string): Parser.QueryMatch[] {
    const lang = this.parser.getLanguage() as Parser.Language;
    const query = new Parser.Query(lang, queryString);
    return query.matches(tree.rootNode);
  }

  /**
   * Read the source text of a file. Convenience method used by SymbolExtractor
   * to avoid redundant file reads when the tree is already cached.
   */
  readSource(filePath: string): string {
    return readFileSync(filePath, 'utf-8');
  }

  /**
   * Invalidate the cache entry for a file path so the next parse re-reads from disk.
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Lazily load and cache a language grammar.
   */
  private loadGrammar(language: string): Parser.Language {
    const existing = this.grammars.get(language);
    if (existing) return existing;

    let grammar: Parser.Language;

    switch (language) {
      case 'php': {
        // tree-sitter-php exports { php, php_only } — use php for full PHP files
        const phpModule = require('tree-sitter-php');
        grammar = phpModule.php ?? phpModule;
        break;
      }
      case 'typescript': {
        const tsModule = require('tree-sitter-typescript');
        grammar = tsModule.typescript ?? tsModule;
        break;
      }
      case 'tsx': {
        const tsModule = require('tree-sitter-typescript');
        grammar = tsModule.tsx ?? tsModule;
        break;
      }
      case 'javascript': {
        grammar = require('tree-sitter-javascript');
        break;
      }
      case 'vue': {
        grammar = require('tree-sitter-vue');
        break;
      }
      case 'python': {
        grammar = require('tree-sitter-python');
        break;
      }
      default:
        throw new Error(`No grammar available for language: ${language}`);
    }

    this.grammars.set(language, grammar);
    return grammar;
  }
}
