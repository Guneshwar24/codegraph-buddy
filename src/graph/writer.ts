import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoGraph, CrossRepoGraph } from '../types.js';

export async function writeGraphs(
  graphs: RepoGraph[],
  crossRepo: CrossRepoGraph,
  outputDir: string
): Promise<void> {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write per-repo graphs
  for (const graph of graphs) {
    const filePath = path.join(outputDir, `${graph.repo}.json`);
    fs.writeFileSync(filePath, JSON.stringify(graph, null, 2), 'utf8');
    console.error(`[codegraph] Written: ${graph.repo}.json (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
  }

  // Write cross-repo graph
  const crossPath = path.join(outputDir, 'cross-repo.json');
  fs.writeFileSync(crossPath, JSON.stringify(crossRepo, null, 2), 'utf8');
  console.error(`[codegraph] Written: cross-repo.json (${crossRepo.edges.length} cross-repo edges)`);
}
