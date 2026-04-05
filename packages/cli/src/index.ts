import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Weave } from '@weave/core';
import type { FileIndexDiagnostics, PluginRuleDiagnostics, WeaveConfig, WeaveStatus } from '@weave/core';
import { parse as parseYaml } from 'yaml';

function loadConfig(projectRoot: string): Partial<WeaveConfig> {
  const configPath = resolve(projectRoot, '.weave', 'config.yaml');
  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return parseYaml(raw) as Partial<WeaveConfig>;
  } catch {
    return {};
  }
}

function createWeave(): Weave {
  const root = process.cwd();
  const config = loadConfig(root);
  return new Weave(root, config);
}

async function withWeave<T>(fn: (weave: Weave) => T | Promise<T>): Promise<T> {
  const weave = createWeave();
  try {
    return await fn(weave);
  } finally {
    weave.close();
  }
}

export function run(argv: string[]): void {
  const program = new Command();

  program
    .name('weave')
    .description('Convention-aware code intelligence graph')
    .version('0.1.0');

  // --- init ---
  program
    .command('init')
    .description('Detect frameworks, load plugins, build initial graph')
    .action(async () => {
      try {
        const stats = await withWeave(weave => weave.init());

        console.log(chalk.green('Initialized weave graph.'));
        console.log();
        console.log(`  Nodes:   ${chalk.bold(String(stats.nodeCount))}`);
        console.log(`  Edges:   ${chalk.bold(String(stats.edgeCount))}`);
        console.log(`  Plugins: ${stats.plugins.length > 0 ? stats.plugins.join(', ') : chalk.dim('none detected')}`);
      } catch (err) {
        printError('init', err);
        process.exitCode = 1;
      }
    });

  // --- query ---
  program
    .command('query <file>')
    .description('Subgraph query — minimal connected context for a task')
    .option('-s, --scope <scope>', 'Scope description for relevance filtering')
    .option('-d, --depth <n>', 'Traversal depth', '3')
    .option('-t, --max-tokens <n>', 'Token budget for result pruning')
    .action(async (file: string, opts: { scope?: string; depth: string; maxTokens?: string }) => {
      try {
        const result = await withWeave(weave => weave.query({
          start: file,
          scope: opts.scope,
          depth: parseInt(opts.depth, 10),
          options: {
            includeConventions: true,
            includeExemplars: true,
            includeSnippets: true,
            maxTokens: opts.maxTokens ? parseInt(opts.maxTokens, 10) : undefined,
          },
        }));

        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        printError('query', err);
        process.exitCode = 1;
      }
    });

  // --- context ---
  program
    .command('context <file>')
    .description('Compact agent context bundle: working set, mined constraints, and exemplars')
    .option('-s, --scope <scope>', 'Scope description for relevance filtering')
    .option('-d, --depth <n>', 'Traversal depth', '2')
    .option('--max-files <n>', 'Max files in the working set', '8')
    .option('--max-constraints <n>', 'Max mined constraints', '6')
    .option('--max-exemplars <n>', 'Max exemplar files', '3')
    .action(async (
      file: string,
      opts: {
        scope?: string;
        depth: string;
        maxFiles: string;
        maxConstraints: string;
        maxExemplars: string;
      },
    ) => {
      try {
        const result = await withWeave(weave => weave.context({
          start: file,
          scope: opts.scope,
          depth: parseInt(opts.depth, 10),
          maxFiles: parseInt(opts.maxFiles, 10),
          maxConstraints: parseInt(opts.maxConstraints, 10),
          maxExemplars: parseInt(opts.maxExemplars, 10),
        }));

        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        printError('context', err);
        process.exitCode = 1;
      }
    });

  // --- conventions ---
  program
    .command('conventions')
    .description('Show derived conventions')
    .option('-k, --kind <kind>', 'Filter by node kind')
    .action(async (opts: { kind?: string }) => {
      try {
        const conventions = await withWeave(weave => weave.conventions(opts.kind));

        if (conventions.length === 0) {
          console.log(chalk.dim('No conventions found.'));
          return;
        }

        // Table header
        const kindW = 16;
        const propW = 40;
        const freqW = 10;
        const confW = 10;

        console.log(
          chalk.bold(
            pad('Kind', kindW) +
            pad('Property', propW) +
            pad('Freq', freqW) +
            pad('Confidence', confW),
          ),
        );
        console.log(chalk.dim('─'.repeat(kindW + propW + freqW + confW)));

        for (const c of conventions) {
          const conf = c.confidence >= 0.9
            ? chalk.green((c.confidence * 100).toFixed(0) + '%')
            : c.confidence >= 0.7
              ? chalk.yellow((c.confidence * 100).toFixed(0) + '%')
              : chalk.red((c.confidence * 100).toFixed(0) + '%');

          console.log(
            pad(c.kind, kindW) +
            pad(c.property, propW) +
            pad(`${c.frequency}/${c.total}`, freqW) +
            conf,
          );
        }
      } catch (err) {
        printError('conventions', err);
        process.exitCode = 1;
      }
    });

  // --- validate ---
  program
    .command('validate <files...>')
    .description('Validate files against derived conventions')
    .option('--strict', 'Treat warnings as errors')
    .option('--exit-code', 'Exit with code 1 if violations found')
    .action(async (files: string[], opts: { strict?: boolean; exitCode?: boolean }) => {
      try {
        const violations = await withWeave(weave => weave.validate(files));

        if (violations.length === 0) {
          console.log(chalk.green('All files pass convention checks.'));
          return;
        }

        for (const v of violations) {
          const threshold = opts.strict ? 0.7 : 0.9;
          const isError = v.confidence >= threshold;
          const prefix = isError ? chalk.red('ERROR') : chalk.yellow('WARN');

          console.log(`${prefix}  ${chalk.bold(v.file)} ${chalk.dim(`(${v.symbol})`)}`);
          console.log(`       ${v.message}`);
          if (v.exemplarFile) {
            console.log(`       ${chalk.dim(`See: ${v.exemplarFile}`)}`);
          }
          console.log();
        }

        const errorCount = violations.filter((v: { confidence: number }) => v.confidence >= (opts.strict ? 0.7 : 0.9)).length;
        const warnCount = violations.length - errorCount;

        console.log(
          `${chalk.red(`${errorCount} error(s)`)}  ${chalk.yellow(`${warnCount} warning(s)`)}`,
        );

        if (opts.exitCode && errorCount > 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        printError('validate', err);
        process.exitCode = 1;
      }
    });

  // --- impact ---
  program
    .command('impact <target>')
    .description('Blast radius analysis — what would be affected by a change')
    .action(async (target: string) => {
      try {
        const result = await withWeave(weave => weave.impact(target));

        if (result.nodes.length === 0) {
          console.log(chalk.dim('No affected files found.'));
          return;
        }

        console.log(chalk.bold(`Affected files (${result.nodes.length}):`));
        console.log();

        const seen = new Set<string>();
        for (const node of result.nodes) {
          if (seen.has(node.file)) continue;
          seen.add(node.file);
          console.log(`  ${node.file}`);
        }

        if (result.edges.length > 0) {
          console.log();
          console.log(chalk.dim(`${result.edges.length} relationship(s) in blast radius.`));
        }
      } catch (err) {
        printError('impact', err);
        process.exitCode = 1;
      }
    });

  // --- status ---
  program
    .command('status')
    .description('Index stats — node/edge counts, active plugins, stale files')
    .action(async () => {
      try {
        const status = await withWeave(weave => weave.status()) as WeaveStatus;

        console.log(chalk.bold('Weave Status'));
        console.log();
        console.log(`  Nodes:       ${chalk.bold(String(status.nodeCount))}`);
        console.log(`  Edges:       ${chalk.bold(String(status.edgeCount))}`);
        console.log(`  Plugins:     ${status.plugins.length > 0 ? status.plugins.join(', ') : chalk.dim('none')}`);
        console.log(`  L2 skipped:  ${status.diagnostics.totals.l2EdgesSkipped}`);
        console.log(`  L3 skipped:  ${status.diagnostics.totals.l3EdgesSkipped}`);
        console.log(`  Issues:      ${status.diagnostics.totals.issues}`);

        if (status.staleFiles.length > 0) {
          console.log(`  Stale files: ${chalk.yellow(String(status.staleFiles.length))}`);
          for (const f of status.staleFiles) {
            console.log(`    ${chalk.dim(f)}`);
          }
        } else {
          console.log(`  Stale files: ${chalk.green('0')}`);
        }

        const noisyFiles = status.diagnostics.files
          .filter((file: FileIndexDiagnostics) => file.l2EdgesSkipped > 0 || file.l3EdgesSkipped > 0 || file.queryErrors > 0)
          .sort((a: FileIndexDiagnostics, b: FileIndexDiagnostics) => (b.l2EdgesSkipped + b.l3EdgesSkipped + b.queryErrors) - (a.l2EdgesSkipped + a.l3EdgesSkipped + a.queryErrors))
          .slice(0, 10);

        if (noisyFiles.length > 0) {
          console.log();
          console.log(chalk.bold('Diagnostic files'));
          for (const file of noisyFiles) {
            console.log(
              `  ${file.file} ${chalk.dim(`(L2 skipped: ${file.l2EdgesSkipped}, L3 skipped: ${file.l3EdgesSkipped}, query errors: ${file.queryErrors})`)}`,
            );
          }
        }

        const noisyRules = status.diagnostics.pluginRules
          .filter((rule: PluginRuleDiagnostics) => rule.edgesSkipped > 0 || rule.queryErrors > 0)
          .sort((a: PluginRuleDiagnostics, b: PluginRuleDiagnostics) => (b.edgesSkipped + b.queryErrors) - (a.edgesSkipped + a.queryErrors))
          .slice(0, 10);

        if (noisyRules.length > 0) {
          console.log();
          console.log(chalk.bold('Diagnostic rules'));
          for (const rule of noisyRules) {
            console.log(
              `  ${rule.plugin}:${rule.rule} ${chalk.dim(`(skipped: ${rule.edgesSkipped}, query errors: ${rule.queryErrors}, created: ${rule.edgesCreated})`)}`,
            );
          }
        }
      } catch (err) {
        printError('status', err);
        process.exitCode = 1;
      }
    });

  // --- plugins ---
  const pluginsCmd = program
    .command('plugins')
    .description('List active convention plugins')
    .action(async () => {
      try {
        const status = await withWeave(weave => weave.status());

        if (status.plugins.length === 0) {
          console.log(chalk.dim('No active plugins.'));
          return;
        }

        console.log(chalk.bold('Active plugins:'));
        console.log();
        for (const name of status.plugins) {
          console.log(`  ${chalk.cyan(name)}`);
        }
      } catch (err) {
        printError('plugins', err);
        process.exitCode = 1;
      }
    });

  pluginsCmd
    .command('add <name>')
    .description('Install a convention plugin')
    .action((name: string) => {
      console.log(chalk.yellow('Plugin installation not yet implemented.'));
      console.log(chalk.dim(`Requested plugin: ${name}`));
    });

  // --- watch ---
  program
    .command('watch')
    .description('File watcher for incremental updates')
    .action(() => {
      console.log(chalk.yellow('File watching not yet implemented.'));
    });

  program.parseAsync(argv).catch((err: unknown) => {
    printError('weave', err);
    process.exitCode = 1;
  });
}

function printError(command: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Error [${command}]: ${message}`));
}

function pad(str: string, width: number): string {
  return str.length >= width ? str + '  ' : str + ' '.repeat(width - str.length);
}
