import { parseRepo } from '../parser/index.js';
import type { RepoGraph } from '../types.js';
import * as path from 'node:path';

export interface RepoConfig {
  name: string;
  path: string;
}

// Default repo configuration for bidbuddy
export function getBidbuddyRepos(baseDir: string): RepoConfig[] {
  return [
    { name: 'agent-backend', path: path.join(baseDir, 'bidbuddy-agent-backend') },
    { name: 'markethub-backend', path: path.join(baseDir, 'bidbuddy-markethub-backend') },
    { name: 'frontend-next', path: path.join(baseDir, 'bidbuddy-frontend-next') },
  ];
}

export async function buildRepoGraph(config: RepoConfig): Promise<RepoGraph> {
  console.error(`[codegraph] Parsing ${config.name}...`);
  const graph = await parseRepo(config.path, config.name);
  console.error(`[codegraph] ${config.name}: ${graph.fileCount} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  return graph;
}

export async function buildAllGraphs(repos: RepoConfig[]): Promise<RepoGraph[]> {
  const graphs: RepoGraph[] = [];
  for (const repo of repos) {
    graphs.push(await buildRepoGraph(repo));
  }
  return graphs;
}
