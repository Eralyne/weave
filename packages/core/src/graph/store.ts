import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import type { WeaveNode, WeaveEdge, Convention, FileCache } from '../types.js';

export class GraphStore {
  private db!: Database.Database;
  private readonly dbPath: string;

  // Prepared statements
  private stmtUpsertNode!: Database.Statement;
  private stmtUpsertEdge!: Database.Statement;
  private stmtGetNodesByFile!: Database.Statement;
  private stmtGetNodesByKind!: Database.Statement;
  private stmtGetNodeById!: Database.Statement;
  private stmtGetEdgesFrom!: Database.Statement;
  private stmtGetEdgesTo!: Database.Statement;
  private stmtGetEdgesBetween!: Database.Statement;
  private stmtDeleteNodesByFile!: Database.Statement;
  private stmtDeleteEdgesForNodes!: Database.Statement;
  private stmtFindNodeBySymbol!: Database.Statement;
  private stmtFindNodeBySymbolAndKind!: Database.Statement;
  private stmtCountNodes!: Database.Statement;
  private stmtCountEdges!: Database.Statement;
  private stmtUpsertFileCache!: Database.Statement;
  private stmtGetFileCache!: Database.Statement;
  private stmtGetAllFileCache!: Database.Statement;
  private stmtDeleteFileCache!: Database.Statement;
  private stmtCreateEdge!: Database.Statement;
  private stmtGetAllNodes!: Database.Statement;
  private stmtClearConventions!: Database.Statement;
  private stmtInsertConvention!: Database.Statement;
  private stmtGetConventionById!: Database.Statement;
  private stmtFindNodesByFilePrefix!: Database.Statement;
  private stmtUpdateNodeMetadata!: Database.Statement;
  private stmtGetNodeByNaturalKey!: Database.Statement;
  private stmtFindEdgeByNaturalKey!: Database.Statement;

  constructor(projectRoot: string) {
    const weaveDir = path.join(projectRoot, '.weave');
    this.dbPath = path.join(weaveDir, 'graph.db');

    if (!fs.existsSync(weaveDir)) {
      fs.mkdirSync(weaveDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id          INTEGER PRIMARY KEY,
        file_path   TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        kind        TEXT NOT NULL,
        language    TEXT NOT NULL,
        line_start  INTEGER NOT NULL,
        line_end    INTEGER NOT NULL,
        signature   TEXT,
        metadata    TEXT
      );

      DROP INDEX IF EXISTS idx_nodes_natural_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_natural_key ON nodes(file_path, symbol_name, kind, line_start);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_nodes_symbol ON nodes(symbol_name);

      CREATE TABLE IF NOT EXISTS edges (
        id          INTEGER PRIMARY KEY,
        source_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        relationship TEXT NOT NULL,
        layer       INTEGER NOT NULL,
        convention  TEXT,
        metadata    TEXT,
        confidence  REAL DEFAULT 1.0
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(relationship);

      CREATE TABLE IF NOT EXISTS file_cache (
        file_path   TEXT PRIMARY KEY,
        mtime       REAL NOT NULL,
        hash        TEXT NOT NULL,
        last_parsed TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conventions (
        id          INTEGER PRIMARY KEY,
        kind        TEXT NOT NULL,
        property    TEXT NOT NULL,
        frequency   INTEGER NOT NULL,
        total       INTEGER NOT NULL,
        confidence  REAL GENERATED ALWAYS AS (CAST(frequency AS REAL) / total) STORED,
        exemplar_id INTEGER REFERENCES nodes(id),
        metadata    TEXT
      );
    `);

    this.prepareStatements();
  }

  resetGraph(): void {
    const reset = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM conventions;
        DELETE FROM edges;
        DELETE FROM nodes;
        DELETE FROM file_cache;
      `);
    });
    reset();
  }

  private prepareStatements(): void {
    this.stmtUpsertNode = this.db.prepare(`
      INSERT INTO nodes (file_path, symbol_name, kind, language, line_start, line_end, signature, metadata)
      VALUES (@filePath, @symbolName, @kind, @language, @lineStart, @lineEnd, @signature, @metadata)
      ON CONFLICT(file_path, symbol_name, kind, line_start) DO UPDATE SET
        kind = excluded.kind,
        language = excluded.language,
        line_end = excluded.line_end,
        signature = excluded.signature,
        metadata = excluded.metadata
    `);

    this.stmtUpsertEdge = this.db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relationship, layer, convention, metadata, confidence)
      VALUES (@id, @sourceId, @targetId, @relationship, @layer, @convention, @metadata, @confidence)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        target_id = excluded.target_id,
        relationship = excluded.relationship,
        layer = excluded.layer,
        convention = excluded.convention,
        metadata = excluded.metadata,
        confidence = excluded.confidence
    `);

    this.stmtGetNodesByFile = this.db.prepare(
      'SELECT * FROM nodes WHERE file_path = ?'
    );

    this.stmtGetNodesByKind = this.db.prepare(
      'SELECT * FROM nodes WHERE kind = ?'
    );

    this.stmtGetNodeById = this.db.prepare(
      'SELECT * FROM nodes WHERE id = ?'
    );

    this.stmtGetEdgesFrom = this.db.prepare(
      'SELECT * FROM edges WHERE source_id = ?'
    );

    this.stmtGetEdgesTo = this.db.prepare(
      'SELECT * FROM edges WHERE target_id = ?'
    );

    this.stmtGetEdgesBetween = this.db.prepare(
      'SELECT * FROM edges WHERE source_id = ? AND target_id = ?'
    );

    this.stmtDeleteNodesByFile = this.db.prepare(
      'DELETE FROM nodes WHERE file_path = ?'
    );

    this.stmtDeleteEdgesForNodes = this.db.prepare(`
      DELETE FROM edges
      WHERE source_id IN (SELECT id FROM nodes WHERE file_path = ?)
         OR target_id IN (SELECT id FROM nodes WHERE file_path = ?)
    `);

    this.stmtFindNodeBySymbol = this.db.prepare(
      'SELECT * FROM nodes WHERE symbol_name = ?'
    );

    this.stmtFindNodeBySymbolAndKind = this.db.prepare(
      'SELECT * FROM nodes WHERE symbol_name = ? AND kind = ?'
    );

    this.stmtCountNodes = this.db.prepare(
      'SELECT COUNT(*) AS count FROM nodes'
    );

    this.stmtCountEdges = this.db.prepare(
      'SELECT COUNT(*) AS count FROM edges'
    );

    this.stmtUpsertFileCache = this.db.prepare(`
      INSERT INTO file_cache (file_path, mtime, hash, last_parsed)
      VALUES (@filePath, @mtime, @hash, @lastParsed)
      ON CONFLICT(file_path) DO UPDATE SET
        mtime = excluded.mtime,
        hash = excluded.hash,
        last_parsed = excluded.last_parsed
    `);

    this.stmtGetFileCache = this.db.prepare(
      'SELECT * FROM file_cache WHERE file_path = ?'
    );

    this.stmtGetAllFileCache = this.db.prepare(
      'SELECT * FROM file_cache'
    );

    this.stmtDeleteFileCache = this.db.prepare(
      'DELETE FROM file_cache WHERE file_path = ?'
    );

    this.stmtCreateEdge = this.db.prepare(`
      INSERT INTO edges (source_id, target_id, relationship, layer, convention, metadata, confidence)
      VALUES (@sourceId, @targetId, @relationship, @layer, @convention, @metadata, @confidence)
    `);

    this.stmtGetAllNodes = this.db.prepare(
      'SELECT * FROM nodes'
    );

    this.stmtClearConventions = this.db.prepare(
      'DELETE FROM conventions'
    );

    this.stmtInsertConvention = this.db.prepare(`
      INSERT INTO conventions (kind, property, frequency, total, exemplar_id, metadata)
      VALUES (@kind, @property, @frequency, @total, @exemplarId, @metadata)
    `);

    this.stmtGetConventionById = this.db.prepare(
      'SELECT * FROM conventions WHERE id = ?'
    );

    this.stmtFindNodesByFilePrefix = this.db.prepare(
      'SELECT * FROM nodes WHERE file_path LIKE ?'
    );

    this.stmtUpdateNodeMetadata = this.db.prepare(
      'UPDATE nodes SET metadata = @metadata WHERE id = @id'
    );

    this.stmtGetNodeByNaturalKey = this.db.prepare(
      'SELECT * FROM nodes WHERE file_path = ? AND symbol_name = ? AND kind = ? AND line_start = ?'
    );

    this.stmtFindEdgeByNaturalKey = this.db.prepare(`
      SELECT *
      FROM edges
      WHERE source_id = @sourceId
        AND target_id = @targetId
        AND relationship = @relationship
        AND layer = @layer
        AND ((metadata IS NULL AND @metadata IS NULL) OR metadata = @metadata)
      LIMIT 1
    `);
  }

  upsertNode(node: WeaveNode): WeaveNode {
    this.stmtUpsertNode.run({
      id: node.id,
      filePath: node.filePath,
      symbolName: node.symbolName,
      kind: node.kind,
      language: node.language,
      lineStart: node.lineStart,
      lineEnd: node.lineEnd,
      signature: node.signature,
      metadata: node.metadata ? JSON.stringify(node.metadata) : null,
    });
    const row = this.stmtGetNodeByNaturalKey.get(
      node.filePath,
      node.symbolName,
      node.kind,
      node.lineStart,
    ) as RawNodeRow;
    return deserializeNode(row);
  }

  upsertEdge(edge: WeaveEdge): void {
    this.stmtUpsertEdge.run({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationship: edge.relationship,
      layer: edge.layer,
      convention: edge.convention,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      confidence: edge.confidence,
    });
  }

  createEdge(edge: Omit<WeaveEdge, 'id'>): WeaveEdge {
    const metadata = edge.metadata ? JSON.stringify(edge.metadata) : null;
    const existing = this.stmtFindEdgeByNaturalKey.get({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationship: edge.relationship,
      layer: edge.layer,
      metadata,
    }) as RawEdgeRow | undefined;

    if (existing) {
      return deserializeEdge(existing);
    }

    const result = this.stmtCreateEdge.run({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationship: edge.relationship,
      layer: edge.layer,
      convention: edge.convention,
      metadata,
      confidence: edge.confidence,
    });
    return {
      id: result.lastInsertRowid as number,
      ...edge,
    };
  }

  getAllNodes(): WeaveNode[] {
    const rows = this.stmtGetAllNodes.all() as RawNodeRow[];
    return rows.map(deserializeNode);
  }

  clearConventions(): void {
    this.stmtClearConventions.run();
  }

  insertConvention(conv: Omit<Convention, 'id' | 'confidence'>): Convention {
    const result = this.stmtInsertConvention.run({
      kind: conv.kind,
      property: conv.property,
      frequency: conv.frequency,
      total: conv.total,
      exemplarId: conv.exemplarId,
      metadata: conv.metadata ? JSON.stringify(conv.metadata) : null,
    });
    const row = this.stmtGetConventionById.get(result.lastInsertRowid) as RawConventionRow;
    return deserializeConvention(row);
  }

  findNodesByFilePrefix(prefix: string): WeaveNode[] {
    const rows = this.stmtFindNodesByFilePrefix.all(`${prefix}%`) as RawNodeRow[];
    return rows.map(deserializeNode);
  }

  updateNodeMetadata(nodeId: number, metadata: Record<string, unknown>): void {
    this.stmtUpdateNodeMetadata.run({
      id: nodeId,
      metadata: JSON.stringify(metadata),
    });
  }

  getNodesByFile(filePath: string): WeaveNode[] {
    const rows = this.stmtGetNodesByFile.all(filePath) as RawNodeRow[];
    return rows.map(deserializeNode);
  }

  getNodesByKind(kind: string): WeaveNode[] {
    const rows = this.stmtGetNodesByKind.all(kind) as RawNodeRow[];
    return rows.map(deserializeNode);
  }

  getNodeById(id: number): WeaveNode | undefined {
    const row = this.stmtGetNodeById.get(id) as RawNodeRow | undefined;
    return row ? deserializeNode(row) : undefined;
  }

  getEdgesFrom(nodeId: number): WeaveEdge[] {
    const rows = this.stmtGetEdgesFrom.all(nodeId) as RawEdgeRow[];
    return rows.map(deserializeEdge);
  }

  getEdgesTo(nodeId: number): WeaveEdge[] {
    const rows = this.stmtGetEdgesTo.all(nodeId) as RawEdgeRow[];
    return rows.map(deserializeEdge);
  }

  getEdgesBetween(sourceId: number, targetId: number): WeaveEdge[] {
    const rows = this.stmtGetEdgesBetween.all(sourceId, targetId) as RawEdgeRow[];
    return rows.map(deserializeEdge);
  }

  removeFileNodes(filePath: string): void {
    const remove = this.db.transaction(() => {
      this.stmtDeleteEdgesForNodes.run(filePath, filePath);
      this.stmtDeleteNodesByFile.run(filePath);
    });
    remove();
  }

  findNodeBySymbol(symbolName: string, kind?: string): WeaveNode[] {
    if (kind) {
      const rows = this.stmtFindNodeBySymbolAndKind.all(symbolName, kind) as RawNodeRow[];
      return rows.map(deserializeNode);
    }
    const rows = this.stmtFindNodeBySymbol.all(symbolName) as RawNodeRow[];
    return rows.map(deserializeNode);
  }

  getConventions(kind?: string): Convention[] {
    let rows: RawConventionRow[];
    if (kind) {
      rows = this.db.prepare('SELECT * FROM conventions WHERE kind = ?').all(kind) as RawConventionRow[];
    } else {
      rows = this.db.prepare('SELECT * FROM conventions').all() as RawConventionRow[];
    }
    return rows.map(deserializeConvention);
  }

  upsertFileCache(entry: FileCache): void {
    this.stmtUpsertFileCache.run({
      filePath: entry.filePath,
      mtime: entry.mtime,
      hash: entry.hash,
      lastParsed: entry.lastParsed,
    });
  }

  getFileCache(filePath: string): FileCache | undefined {
    const row = this.stmtGetFileCache.get(filePath) as RawFileCacheRow | undefined;
    return row ? deserializeFileCache(row) : undefined;
  }

  getAllFileCache(): FileCache[] {
    const rows = this.stmtGetAllFileCache.all() as RawFileCacheRow[];
    return rows.map(deserializeFileCache);
  }

  deleteFileCache(filePath: string): void {
    this.stmtDeleteFileCache.run(filePath);
  }

  getStats(): { nodeCount: number; edgeCount: number } {
    const nodeRow = this.stmtCountNodes.get() as { count: number };
    const edgeRow = this.stmtCountEdges.get() as { count: number };
    return { nodeCount: nodeRow.count, edgeCount: edgeRow.count };
  }

  close(): void {
    this.db.close();
  }
}

// Raw row types matching SQLite column names

interface RawNodeRow {
  id: number;
  file_path: string;
  symbol_name: string;
  kind: string;
  language: string;
  line_start: number;
  line_end: number;
  signature: string | null;
  metadata: string | null;
}

interface RawEdgeRow {
  id: number;
  source_id: number;
  target_id: number;
  relationship: string;
  layer: number;
  convention: string | null;
  metadata: string | null;
  confidence: number;
}

interface RawFileCacheRow {
  file_path: string;
  mtime: number;
  hash: string;
  last_parsed: string;
}

interface RawConventionRow {
  id: number;
  kind: string;
  property: string;
  frequency: number;
  total: number;
  confidence: number;
  exemplar_id: number | null;
  metadata: string | null;
}

function deserializeNode(row: RawNodeRow): WeaveNode {
  return {
    id: row.id,
    filePath: row.file_path,
    symbolName: row.symbol_name,
    kind: row.kind,
    language: row.language,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    signature: row.signature,
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
  };
}

function deserializeEdge(row: RawEdgeRow): WeaveEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relationship: row.relationship,
    layer: row.layer as 1 | 2 | 3,
    convention: row.convention,
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
    confidence: row.confidence,
  };
}

function deserializeFileCache(row: RawFileCacheRow): FileCache {
  return {
    filePath: row.file_path,
    mtime: row.mtime,
    hash: row.hash,
    lastParsed: row.last_parsed,
  };
}

function deserializeConvention(row: RawConventionRow): Convention {
  return {
    id: row.id,
    kind: row.kind,
    property: row.property,
    frequency: row.frequency,
    total: row.total,
    confidence: row.confidence,
    exemplarId: row.exemplar_id,
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
  };
}
