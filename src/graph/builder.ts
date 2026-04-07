import { parseRepo } from '../parser/index.js';
import type { RepoGraph, CodeGraphConfig, RepoConfig } from '../types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export type { RepoConfig };

const CONFIG_FILENAME = 'codegraph.config.json';

/**
 * Find codegraph.config.json by walking up from startDir.
 * Returns the config file path if found, null otherwise.
 */
export function findConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Load and parse a codegraph.config.json file.
 * Repo paths in the config are resolved relative to the config file's directory.
 */
export function loadConfig(configPath: string): { config: CodeGraphConfig; configDir: string; outputDir: string } {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config: CodeGraphConfig = JSON.parse(raw);

  if (!config.repos || config.repos.length === 0) {
    throw new Error(`No repos defined in ${configPath}`);
  }

  const configDir = path.dirname(configPath);

  // Resolve repo paths relative to config file
  config.repos = config.repos.map(r => ({
    ...r,
    path: path.isAbsolute(r.path) ? r.path : path.resolve(configDir, r.path),
  }));

  const outputDir = config.output
    ? path.isAbsolute(config.output) ? config.output : path.resolve(configDir, config.output)
    : path.join(configDir, '.codegraph');

  return { config, configDir, outputDir };
}

export async function buildRepoGraph(repo: RepoConfig): Promise<RepoGraph> {
  console.error(`[codegraph] Parsing ${repo.name} at ${repo.path}...`);
  const graph = await parseRepo(repo.path, repo.name);
  console.error(`[codegraph] ${repo.name}: ${graph.fileCount} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  return graph;
}

export async function buildAllGraphs(repos: RepoConfig[]): Promise<RepoGraph[]> {
  const graphs: RepoGraph[] = [];
  for (const repo of repos) {
    if (!fs.existsSync(repo.path)) {
      console.error(`[codegraph] Warning: Repo not found at ${repo.path} — skipping`);
      continue;
    }
    graphs.push(await buildRepoGraph(repo));
  }
  return graphs;
}
