import type { RepoGraph, CrossRepoGraph, GraphEdge } from '../types.js';

export function buildCrossRepoEdges(graphs: RepoGraph[]): CrossRepoGraph {
  const crossEdges: GraphEdge[] = [];

  // 1. Build lookup: HTTP path → route node ID
  // Collect all route nodes from backend repos
  const routeIndex = new Map<string, string>(); // normalized path → node ID

  for (const graph of graphs) {
    if (graph.repo === 'agent-backend' || graph.repo === 'markethub-backend') {
      for (const node of graph.nodes) {
        if (node.kind === 'route' && node.meta?.httpPath) {
          const key = `${node.meta.httpMethod?.toUpperCase() ?? 'ANY'}:${node.meta.httpPath}`;
          routeIndex.set(key, node.id);
          // Also index by path alone (method-agnostic lookup)
          routeIndex.set(node.meta.httpPath, node.id);
        }
      }
    }
  }

  // 2. Match frontend fetch() calls to backend routes
  const frontendGraph = graphs.find(g => g.repo === 'frontend-next');
  if (frontendGraph) {
    for (const edge of frontendGraph.edges) {
      if (edge.kind === 'http_calls') {
        // edge.to is a URL path like "/api/agents/run"
        const url = edge.to;
        // Try to find matching backend route
        const routeNodeId = routeIndex.get(url);
        if (routeNodeId) {
          crossEdges.push({
            from: edge.from,
            to: routeNodeId,
            kind: 'http_calls',
            crossRepo: true,
          });
        } else {
          // Keep the unresolved edge with the raw URL as target
          // (useful for knowing what routes frontend calls even if not found in graph)
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

  // 3. Python cross-repo imports: agent-backend → markethub-backend
  const agentGraph = graphs.find(g => g.repo === 'agent-backend');
  const markethubGraph = graphs.find(g => g.repo === 'markethub-backend');

  if (agentGraph && markethubGraph) {
    // Build a set of module names that exist in markethub-backend
    const markethubModules = new Set<string>();
    for (const node of markethubGraph.nodes) {
      if (node.kind === 'file' || node.kind === 'package') {
        // Convert file path to module name: "services/tender_api/main.py" → "tender_api"
        const parts = node.file.split('/');
        for (const part of parts) {
          const modName = part.replace('.py', '').replace(/-/g, '_');
          markethubModules.add(modName);
        }
      }
    }

    // Find agent-backend edges that import markethub modules
    for (const edge of agentGraph.edges) {
      if (edge.kind === 'imports') {
        const importTarget = edge.to;
        // Check if this import references a markethub module
        const targetParts = importTarget.split('.');
        for (const part of targetParts) {
          if (markethubModules.has(part) ||
              importTarget.includes('markethub') ||
              importTarget.includes('tender_api') ||
              importTarget.includes('tender_search')) {
            crossEdges.push({
              from: edge.from,
              to: `markethub-backend::${importTarget}`,
              kind: 'depends_on',
              crossRepo: true,
            });
            break;
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
