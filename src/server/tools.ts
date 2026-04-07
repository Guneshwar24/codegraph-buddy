import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import type { GraphLoader } from './loader.js';

export function registerTools(server: McpServer, loader: GraphLoader): void {
  // Tool 1: shake
  server.tool('shake', 'High-level overview of all three bidbuddy repos. Start here before any other tool.', {}, async () => {
    const graphs = loader.getGraphs();
    const result = graphs.map(g => ({
      repo: g.repo,
      builtAt: g.builtAt,
      fileCount: g.fileCount,
      nodeCounts: {
        functions: g.nodes.filter(n => n.kind === 'function').length,
        classes: g.nodes.filter(n => n.kind === 'class').length,
        methods: g.nodes.filter(n => n.kind === 'method').length,
        routes: g.nodes.filter(n => n.kind === 'route').length,
        agents: g.nodes.filter(n => n.kind === 'agent').length,
        types: g.nodes.filter(n => n.kind === 'type').length,
        interfaces: g.nodes.filter(n => n.kind === 'interface').length,
      },
      topFiles: g.nodes
        .filter(n => n.kind === 'file')
        .slice(0, 10)
        .map(n => n.file),
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  // Tool 2: architecture_map
  server.tool('architecture_map', 'Cross-repo dependency graph showing how the three bidbuddy repos connect via HTTP calls and imports.', {}, async () => {
    const crossRepo = loader.getCrossRepo();
    const graphs = loader.getGraphs();
    // Collapse to package level: group edges by from-repo → to-repo
    const packageEdges: Array<{ from: string; to: string; kind: string; count: number }> = [];
    const edgeMap = new Map<string, number>();
    for (const edge of crossRepo.edges) {
      const fromNode = loader.nodeById(edge.from);
      const fromRepo = fromNode?.repo ?? edge.from.split('::')[0] ?? 'unknown';
      const toRepo = edge.to.split('::')[0] ?? 'unknown';
      const key = `${fromRepo}→${toRepo}:${edge.kind}`;
      edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
    }
    for (const [key, count] of edgeMap) {
      const [fromTo, kind] = key.split(':');
      const [from, to] = (fromTo ?? '').split('→');
      packageEdges.push({ from: from ?? '', to: to ?? '', kind: kind ?? '', count });
    }
    const result = {
      repos: graphs.map(g => ({ name: g.repo, fileCount: g.fileCount, nodeCount: g.nodes.length })),
      crossRepoEdges: packageEdges,
      builtAt: crossRepo.builtAt,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  // Tool 3: repo_summary
  server.tool(
    'repo_summary',
    'Detailed summary of one repo: all routes, agents, classes, and key functions.',
    { repo: z.enum(['agent-backend', 'markethub-backend', 'frontend-next']).describe('Which repo to summarize') },
    async ({ repo }) => {
      const graph = loader.getGraphs().find(g => g.repo === repo);
      if (!graph) return { content: [{ type: 'text' as const, text: `Repo not found: ${repo}` }], isError: true };
      const result = {
        repo: graph.repo,
        fileCount: graph.fileCount,
        builtAt: graph.builtAt,
        routes: graph.nodes.filter(n => n.kind === 'route').map(n => ({
          name: n.name, file: n.file, method: n.meta?.httpMethod, path: n.meta?.httpPath,
        })),
        agents: graph.nodes.filter(n => n.kind === 'agent').map(n => ({
          name: n.name, file: n.file, nodes: n.meta?.agentNodes,
        })),
        classes: graph.nodes.filter(n => n.kind === 'class').map(n => ({ name: n.name, file: n.file })),
        functions: graph.nodes.filter(n => n.kind === 'function').slice(0, 50).map(n => ({ name: n.name, file: n.file })),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool 4: list_agents
  server.tool('list_agents', 'List all LangGraph agents with their internal node topology and edge connections.', {}, async () => {
    const agents = loader.nodesByKind('agent');
    const result = agents.map(a => ({
      id: a.id,
      name: a.name,
      file: a.file,
      repo: a.repo,
      agentType: a.meta?.agentType,
      nodes: a.meta?.agentNodes ?? [],
      edges: a.meta?.agentEdges ?? [],
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  // Tool 5: trace_request
  server.tool(
    'trace_request',
    'Trace a URL path through the full stack: frontend fetch → API route → agent → downstream services.',
    { path: z.string().describe('URL path to trace, e.g. "/api/agents/run"') },
    async ({ path: urlPath }) => {
      // Find frontend nodes that call this path
      const frontendCalls: Array<{ nodeId: string; file: string }> = [];
      for (const graph of loader.getGraphs()) {
        if (graph.repo !== 'frontend-next') continue;
        for (const edge of graph.edges) {
          if (edge.kind === 'http_calls' && edge.to.includes(urlPath)) {
            const fromNode = loader.nodeById(edge.from);
            frontendCalls.push({ nodeId: edge.from, file: fromNode?.file ?? edge.from });
          }
        }
      }
      // Find backend route nodes matching this path
      const routes = loader.nodesByKind('route').filter(n =>
        n.meta?.httpPath === urlPath || n.meta?.httpPath?.endsWith(urlPath)
      );
      // For each route, BFS to find what it calls
      const downstream = routes.flatMap(route => {
        const visited = loader.bfsFrom(route.id, 3);
        return Array.from(visited.values()).filter(n => n.id !== route.id).map(n => ({
          id: n.id, name: n.name, kind: n.kind, file: n.file, repo: n.repo,
        }));
      });
      const result = { urlPath, frontendCallSites: frontendCalls, backendRoutes: routes.map(r => ({ id: r.id, name: r.name, file: r.file, method: r.meta?.httpMethod })), downstream };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool 6: get_symbol
  server.tool(
    'get_symbol',
    'Get details about a specific symbol: its definition, callers, and callees.',
    {
      name: z.string().describe('Symbol name to look up'),
      repo: z.string().optional().describe('Optional: limit to one repo'),
    },
    async ({ name, repo }) => {
      const nodes = loader.search(name, undefined, repo).slice(0, 10);
      if (nodes.length === 0) return { content: [{ type: 'text' as const, text: `No symbol found: ${name}` }], isError: true };
      const result = nodes.map(node => ({
        id: node.id, name: node.name, kind: node.kind, file: node.file, repo: node.repo,
        startLine: node.startLine, endLine: node.endLine, meta: node.meta,
        callers: loader.edgesTo(node.id).map(e => ({ from: e.from, kind: e.kind })).slice(0, 20),
        callees: loader.edgesFrom(node.id).map(e => ({ to: e.to, kind: e.kind })).slice(0, 20),
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool 7: search
  server.tool(
    'search',
    'Search for symbols by name across all repos. Supports optional kind and repo filters.',
    {
      query: z.string().describe('Search term (case-insensitive substring match on symbol names and file paths)'),
      kind: z.enum(['function', 'class', 'method', 'type', 'interface', 'route', 'agent', 'agent_node', 'file', 'package']).optional().describe('Filter by node kind'),
      repo: z.enum(['agent-backend', 'markethub-backend', 'frontend-next']).optional().describe('Filter by repo'),
    },
    async ({ query, kind, repo }) => {
      const nodes = loader.search(query, kind as any, repo).slice(0, 30);
      const result = nodes.map(n => ({ id: n.id, name: n.name, kind: n.kind, file: n.file, repo: n.repo, startLine: n.startLine }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool 8: get_source
  server.tool(
    'get_source',
    'Get the actual source code for a symbol by node ID. Use as last resort — prefer other tools first.',
    { nodeId: z.string().describe('Node ID from search or get_symbol results') },
    async ({ nodeId }) => {
      const node = loader.nodeById(nodeId);
      if (!node) return { content: [{ type: 'text' as const, text: `Node not found: ${nodeId}` }], isError: true };
      // Find the repo path
      const graph = loader.getGraphs().find(g => g.repo === node.repo);
      if (!graph) return { content: [{ type: 'text' as const, text: `Repo not found: ${node.repo}` }], isError: true };
      const absPath = `${graph.repoPath}/${node.file}`;
      try {
        const lines = fs.readFileSync(absPath, 'utf8').split('\n');
        const start = Math.max(0, node.startLine - 1);
        const end = Math.min(lines.length, node.endLine + 1);
        const source = lines.slice(start, end).join('\n');
        const result = { nodeId, name: node.name, file: node.file, repo: node.repo, startLine: node.startLine, endLine: node.endLine, source };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to read source: ${err}` }], isError: true };
      }
    }
  );
}
