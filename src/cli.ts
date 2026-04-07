#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as url from 'node:url';
import { findConfig, loadConfig, buildAllGraphs } from './graph/builder.js';
import { buildCrossRepoEdges } from './graph/cross-repo.js';
import { writeGraphs } from './graph/writer.js';
import { startServer } from './server/index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

program
  .name('codegraph')
  .description('Cross-repo code knowledge graph MCP server')
  .version('0.1.0');

// ─── BUILD ────────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Parse all repos defined in codegraph.config.json and write .codegraph/*.json')
  .option('-c, --config <path>', 'Path to codegraph.config.json (auto-detected if not specified)')
  .action(async (opts) => {
    const configPath = resolveConfig(opts.config as string | undefined);
    const { config, outputDir } = loadConfig(configPath);

    console.error(`[codegraph] Config: ${configPath}`);
    console.error(`[codegraph] Output: ${outputDir}`);
    console.error(`[codegraph] Repos: ${config.repos.map(r => r.name).join(', ')}`);

    const startTime = Date.now();
    const graphs = await buildAllGraphs(config.repos);

    if (graphs.length === 0) {
      console.error('[codegraph] Error: No repos could be parsed. Check your config paths.');
      process.exit(1);
    }

    const crossRepo = buildCrossRepoEdges(graphs);
    await writeGraphs(graphs, crossRepo, outputDir);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalNodes = graphs.reduce((sum, g) => sum + g.nodes.length, 0);
    const totalEdges = graphs.reduce((sum, g) => sum + g.edges.length, 0);
    console.error(`\n[codegraph] Done in ${elapsed}s`);
    console.error(`[codegraph] Total: ${totalNodes} nodes, ${totalEdges} intra-repo edges, ${crossRepo.edges.length} cross-repo edges`);
  });

// ─── SERVE ────────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start MCP server on stdio')
  .option('-c, --config <path>', 'Path to codegraph.config.json (auto-detected if not specified)')
  .option('-d, --dir <path>', 'Path to .codegraph directory (overrides config)')
  .action(async (opts) => {
    let outputDir: string;
    if (opts.dir) {
      outputDir = path.resolve(opts.dir as string);
    } else {
      const configPath = resolveConfig(opts.config as string | undefined);
      const loaded = loadConfig(configPath);
      outputDir = loaded.outputDir;
    }
    await startServer(outputDir);
  });

// ─── STATUS ───────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show graph stats from last build')
  .option('-c, --config <path>', 'Path to codegraph.config.json (auto-detected if not specified)')
  .action((opts) => {
    let outputDir: string;
    try {
      const configPath = resolveConfig(opts.config as string | undefined);
      const loaded = loadConfig(configPath);
      outputDir = loaded.outputDir;
    } catch {
      // Fallback: look for .codegraph next to the cli
      outputDir = path.join(__dirname, '..', '.codegraph');
    }

    if (!fs.existsSync(outputDir)) {
      console.log('No graph built yet. Run: codegraph build');
      return;
    }

    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.json') && f !== 'cross-repo.json');
    if (files.length === 0) {
      console.log('No graph built yet. Run: codegraph build');
      return;
    }

    for (const file of files) {
      const raw = fs.readFileSync(path.join(outputDir, file), 'utf8');
      const graph = JSON.parse(raw);
      console.log(`${graph.repo}: ${graph.fileCount} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges (built ${graph.builtAt})`);
    }

    const crossPath = path.join(outputDir, 'cross-repo.json');
    if (fs.existsSync(crossPath)) {
      const raw = fs.readFileSync(crossPath, 'utf8');
      const cross = JSON.parse(raw);
      console.log(`cross-repo: ${cross.edges.length} cross-repo edges`);
    }
  });

// ─── INIT ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a starter codegraph.config.json in the current directory')
  .action(() => {
    const target = path.join(process.cwd(), 'codegraph.config.json');
    if (fs.existsSync(target)) {
      console.log('codegraph.config.json already exists.');
      return;
    }
    const starter = {
      repos: [
        { name: 'my-backend', path: '../my-backend' },
        { name: 'my-frontend', path: '../my-frontend' },
      ],
      output: '.codegraph',
    };
    fs.writeFileSync(target, JSON.stringify(starter, null, 2) + '\n', 'utf8');
    console.log('Created codegraph.config.json — edit the repo paths then run: codegraph build');
  });

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function resolveConfig(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) throw new Error(`Config not found: ${resolved}`);
    return resolved;
  }
  // Auto-detect: walk up from cwd
  const found = findConfig(process.cwd());
  if (found) return found;
  // Fallback: look next to the compiled cli.js
  const sibling = path.join(__dirname, '..', 'codegraph.config.json');
  if (fs.existsSync(sibling)) return sibling;
  throw new Error(
    'No codegraph.config.json found. Run `codegraph init` to create one, or pass --config <path>.'
  );
}

program.parse();
