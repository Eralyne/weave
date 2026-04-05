import type {
  FileIndexDiagnostics,
  IndexingDiagnostics,
  IndexingIssue,
  PluginRuleDiagnostics,
} from './types.js';

export class IndexingDiagnosticsCollector {
  private files = new Map<string, FileIndexDiagnostics>();
  private pluginRules = new Map<string, PluginRuleDiagnostics>();
  private issues: IndexingIssue[] = [];

  reset(): void {
    this.files.clear();
    this.pluginRules.clear();
    this.issues = [];
  }

  recordL2EdgeCreated(file: string, count: number = 1): void {
    this.ensureFile(file).l2EdgesCreated += count;
  }

  recordL2EdgeSkipped(
    file: string,
    relationship: string | undefined,
    reason: string,
    details?: Record<string, unknown>,
  ): void {
    this.ensureFile(file).l2EdgesSkipped += 1;
    this.issues.push({
      file,
      layer: 2,
      reason,
      relationship,
      details: details ?? null,
    });
  }

  recordRuleFileEvaluated(plugin: string, rule: string, file: string): void {
    this.ensurePluginRule(plugin, rule).filesEvaluated += 1;
    this.ensureFile(file);
  }

  recordRuleMatch(plugin: string, rule: string): void {
    this.ensurePluginRule(plugin, rule).matches += 1;
  }

  recordL3EdgeCreated(plugin: string, rule: string, file: string, count: number = 1): void {
    this.ensurePluginRule(plugin, rule).edgesCreated += count;
    this.ensureFile(file).l3EdgesCreated += count;
  }

  recordL3EdgeSkipped(
    plugin: string,
    rule: string,
    file: string,
    relationship: string | undefined,
    reason: string,
    details?: Record<string, unknown>,
  ): void {
    this.ensurePluginRule(plugin, rule).edgesSkipped += 1;
    this.ensureFile(file).l3EdgesSkipped += 1;
    this.issues.push({
      file,
      layer: 3,
      plugin,
      rule,
      relationship,
      reason,
      details: details ?? null,
    });
  }

  recordNodeCreated(plugin: string, rule: string, file: string): void {
    this.ensurePluginRule(plugin, rule).nodesCreated += 1;
    this.ensureFile(file).nodeCreates += 1;
  }

  recordMetadataUpdated(plugin: string, rule: string, file: string, count: number): void {
    this.ensurePluginRule(plugin, rule).metadataUpdates += count;
    this.ensureFile(file).metadataUpdates += count;
  }

  recordQueryError(
    plugin: string,
    rule: string,
    file: string,
    error: unknown,
  ): void {
    this.ensurePluginRule(plugin, rule).queryErrors += 1;
    this.ensureFile(file).queryErrors += 1;
    this.issues.push({
      file,
      layer: 3,
      plugin,
      rule,
      reason: 'query_error',
      details: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  snapshot(): IndexingDiagnostics {
    const files = Array.from(this.files.values()).sort((a, b) => a.file.localeCompare(b.file));
    const pluginRules = Array.from(this.pluginRules.values())
      .sort((a, b) => {
        if (a.plugin !== b.plugin) return a.plugin.localeCompare(b.plugin);
        return a.rule.localeCompare(b.rule);
      });
    const issues = [...this.issues];

    return {
      totals: {
        l2EdgesCreated: files.reduce((sum, file) => sum + file.l2EdgesCreated, 0),
        l2EdgesSkipped: files.reduce((sum, file) => sum + file.l2EdgesSkipped, 0),
        l3EdgesCreated: files.reduce((sum, file) => sum + file.l3EdgesCreated, 0),
        l3EdgesSkipped: files.reduce((sum, file) => sum + file.l3EdgesSkipped, 0),
        nodeCreates: files.reduce((sum, file) => sum + file.nodeCreates, 0),
        metadataUpdates: files.reduce((sum, file) => sum + file.metadataUpdates, 0),
        queryErrors: files.reduce((sum, file) => sum + file.queryErrors, 0),
        issues: issues.length,
      },
      files,
      pluginRules,
      issues,
    };
  }

  private ensureFile(file: string): FileIndexDiagnostics {
    const existing = this.files.get(file);
    if (existing) return existing;

    const created: FileIndexDiagnostics = {
      file,
      l2EdgesCreated: 0,
      l2EdgesSkipped: 0,
      l3EdgesCreated: 0,
      l3EdgesSkipped: 0,
      nodeCreates: 0,
      metadataUpdates: 0,
      queryErrors: 0,
    };
    this.files.set(file, created);
    return created;
  }

  private ensurePluginRule(plugin: string, rule: string): PluginRuleDiagnostics {
    const key = `${plugin}::${rule}`;
    const existing = this.pluginRules.get(key);
    if (existing) return existing;

    const created: PluginRuleDiagnostics = {
      plugin,
      rule,
      filesEvaluated: 0,
      matches: 0,
      edgesCreated: 0,
      edgesSkipped: 0,
      nodesCreated: 0,
      metadataUpdates: 0,
      queryErrors: 0,
    };
    this.pluginRules.set(key, created);
    return created;
  }
}
