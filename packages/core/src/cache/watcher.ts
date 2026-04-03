import fs from 'node:fs';
import crypto from 'node:crypto';
import { glob } from 'glob';
import { GraphStore } from '../graph/store.js';

const SOURCE_EXTENSIONS = ['.php', '.ts', '.tsx', '.js', '.jsx', '.vue', '.py'];

const EXCLUDED_DIRS = ['node_modules', 'vendor', 'dist', '.git', '.weave'];

export class FileWatcher {
  private store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  async discoverFiles(root: string): Promise<string[]> {
    const patterns = SOURCE_EXTENSIONS.map(ext => `**/*${ext}`);
    const ignore = EXCLUDED_DIRS.map(dir => `**/${dir}/**`);

    const files = await glob(patterns, {
      cwd: root,
      absolute: true,
      nodir: true,
      ignore,
    });

    return files.sort();
  }

  updateCache(filePath: string): void {
    const mtime = this.getMtime(filePath);
    const hash = this.getContentHash(filePath);

    this.store.upsertFileCache({
      filePath,
      mtime,
      hash,
      lastParsed: new Date().toISOString(),
    });
  }

  getStaleFiles(): string[] {
    const cached = this.store.getAllFileCache();
    const stale: string[] = [];

    for (const entry of cached) {
      if (this.isStaleEntry(entry.filePath, entry)) {
        stale.push(entry.filePath);
      }
    }

    return stale;
  }

  isStale(filePath: string): boolean {
    const cached = this.store.getFileCache(filePath);
    if (!cached) {
      return true;
    }
    return this.isStaleEntry(filePath, cached);
  }

  private isStaleEntry(
    filePath: string,
    cached: { mtime: number; hash: string },
  ): boolean {
    if (!fs.existsSync(filePath)) {
      return true;
    }

    const currentMtime = this.getMtime(filePath);
    if (currentMtime !== cached.mtime) {
      const currentHash = this.getContentHash(filePath);
      return currentHash !== cached.hash;
    }

    return false;
  }

  private getMtime(filePath: string): number {
    return fs.statSync(filePath).mtimeMs;
  }

  private getContentHash(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
