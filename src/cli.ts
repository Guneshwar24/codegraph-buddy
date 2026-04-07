#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as url from 'node:url';
import { getBidbuddyRepos, buildAllGraphs } from './graph/builder.js';
import { buildCrossRepoEdges } from './graph/cross-repo.js';
import { writeGraphs } from './graph/writer.js';
import { startServer } from './server/index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The codegraph project lives at bidbuddy/codegraph/
// The base bidbuddy dir is one level up
const BIDBUDDY_DIR = path.resolve(__dirname, '..', '..');
const CODEGRAPH_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(CODEGRAPH_DIR, '.codegraph');

const program = new Command();

program
  .name('codegraph')
  .description('Cross-repo code knowledge graph MCP server for bidbuddy')
  .version('0.1.0');

program
  .command('build')
  .description('Parse all bidbuddy repos and write .codegraph/*.json')
  .option('-d, --dir <path>', 'Base directory containing bidbuddy repos', BIDBUDDY_DIR)
  .action(async (opts) => {
    const baseDir = opts.dir as string;
    const outputDir = OUTPUT_DIR;

    console.error(`[codegraph] Base dir: ${baseDir}`);
    console.error(`[codegraph] Output: ${outputDir}`);

    const startTime = Date.now();
    const repos = getBidbuddyRepos(baseDir);

    // Verify repos exist
    for (const repo of repos) {
      if (!fs.existsSync(repo.path)) {
        console.error(`[codegraph] Warning: Repo not found at ${repo.path} — skipping`);
      }
    }

    const existingRepos = repos.filter(r => fs.existsSync(r.path));
    if (existingRepos.length === 0) {
      console.error('[codegraph] Error: No repos found. Check that bidbuddy repos are at the expected paths.');
      process.exit(1);
    }

    const graphs = await buildAllGraphs(existingRepos);
    const crossRepo = buildCrossRepoEdges(graphs);
    await writeGraphs(graphs, crossRepo, outputDir);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalNodes = graphs.reduce((sum, g) => sum + g.nodes.length, 0);
    const totalEdges = graphs.reduce((sum, g) => sum + g.edges.length, 0);
    console.error(`\n[codegraph] Done in ${elapsed}s`);
    console.error(`[codegraph] Total: ${totalNodes} nodes, ${totalEdges} intra-repo edges, ${crossRepo.edges.length} cross-repo edges`);
  });

program
  .command('serve')
  .description('Start MCP server on stdio')
  .option('-d, --dir <path>', 'Path to .codegraph directory', OUTPUT_DIR)
  .action(async (opts) => {
    await startServer(opts.dir as string);
  });

program
  .command('status')
  .description('Show graph stats from last build')
  .action(() => {
    if (!fs.existsSync(OUTPUT_DIR)) {
      console.log('No graph built yet. Run: node dist/cli.js build');
      return;
    }
    const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.json') && f !== 'cross-repo.json');
    if (files.length === 0) {
      console.log('No graph built yet. Run: node dist/cli.js build');
      return;
    }
    for (const file of files) {
      const raw = fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8');
      const graph = JSON.parse(raw);
      console.log(`${graph.repo}: ${graph.fileCount} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges (built ${graph.builtAt})`);
    }
    const crossPath = path.join(OUTPUT_DIR, 'cross-repo.json');
    if (fs.existsSync(crossPath)) {
      const raw = fs.readFileSync(crossPath, 'utf8');
      const cross = JSON.parse(raw);
      console.log(`cross-repo: ${cross.edges.length} cross-repo edges`);
    }
  });

program.parse();
