import type { RepoGraph, CrossRepoGraph, GraphEdge } from '../types.js';

export function buildCrossRepoEdges(graphs: RepoGraph[]): CrossRepoGraph {
  const crossEdges: GraphEdge[] = [];

  // 1. Build lookup: HTTP path → route node ID
  // Index all route nodes from ALL repos (any repo can expose routes)
  const routeIndex = new Map<string, string>(); // normalized path → node ID

  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (node.kind === 'route' && node.meta?.httpPath) {
        const key = `${node.meta.httpMethod?.toUpperCase() ?? 'ANY'}:${node.meta.httpPath}`;
        routeIndex.set(key, node.id);
        // Also index by path alone (method-agnostic fallback)
        routeIndex.set(node.meta.httpPath, node.id);
      }
    }
  }

  // 2. Match fetch() http_calls edges from any repo to route nodes in any other repo
  for (const graph of graphs) {
    for (const edge of graph.edges) {
      if (edge.kind === 'http_calls') {
        const url = edge.to;
        const routeNodeId = routeIndex.get(url);
        if (routeNodeId) {
          // Resolved: link to the actual route node
          const routeNode = graphs.flatMap(g => g.nodes).find(n => n.id === routeNodeId);
          if (routeNode && routeNode.repo !== graph.repo) {
            crossEdges.push({
              from: edge.from,
              to: routeNodeId,
              kind: 'http_calls',
              crossRepo: true,
            });
          }
        } else {
          // Unresolved: keep as raw URL — still useful for knowing what is called
          crossEdges.push({
            from: edge.from,
            to: `unresolved::${url}`,
            kind: 'http_calls',
            crossRepo: true,
          });
        }
      }
    }
  }

  // 3. Cross-repo Python import linking
  // For each Python repo, build an index of its module names.
  // Then check import edges in other Python repos to see if they reference those modules.
  const pythonRepos = graphs.filter(g =>
    g.nodes.some(n => n.file.endsWith('.py'))
  );

  for (const sourceGraph of pythonRepos) {
    // Build module name index for all OTHER python repos
    for (const targetGraph of pythonRepos) {
      if (targetGraph.repo === sourceGraph.repo) continue;

      const targetModules = new Set<string>();
      for (const node of targetGraph.nodes) {
        const parts = node.file.split('/');
        for (const part of parts) {
          const modName = part.replace('.py', '').replace(/-/g, '_');
          if (modName && modName !== '__init__') targetModules.add(modName);
        }
      }

      // Check source repo import edges for references to target modules
      for (const edge of sourceGraph.edges) {
        if (edge.kind === 'imports') {
          const importTarget = edge.to;
          const targetParts = importTarget.split('.');
          const matchedModule = targetParts.find(p => targetModules.has(p));
          if (matchedModule) {
            crossEdges.push({
              from: edge.from,
              to: `${targetGraph.repo}::${importTarget}`,
              kind: 'depends_on',
              crossRepo: true,
            });
          }
        }
      }
    }
  }

  return {
    builtAt: new Date().toISOString(),
    repos: graphs.map(g => g.repo),
    edges: crossEdges,
  };
}
