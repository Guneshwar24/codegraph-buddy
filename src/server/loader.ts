import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoGraph, CrossRepoGraph, GraphNode, GraphEdge, NodeKind, AllGraphs } from '../types.js';

export class GraphLoader {
  private graphs: RepoGraph[] = [];
  private crossRepo: CrossRepoGraph = { builtAt: '', repos: [], edges: [] };
  private nodeIndex: Map<string, GraphNode> = new Map();
  private edgesFromIndex: Map<string, GraphEdge[]> = new Map();
  private edgesToIndex: Map<string, GraphEdge[]> = new Map();

  load(codegraphDir: string): AllGraphs {
    this.graphs = [];
    this.nodeIndex.clear();
    this.edgesFromIndex.clear();
    this.edgesToIndex.clear();

    if (!fs.existsSync(codegraphDir)) {
      throw new Error(`Graph directory not found: ${codegraphDir}. Run 'codegraph build' first.`);
    }

    // Load all repo JSON files
    const files = fs.readdirSync(codegraphDir).filter(f => f.endsWith('.json') && f !== 'cross-repo.json');
    for (const file of files) {
      const raw = fs.readFileSync(path.join(codegraphDir, file), 'utf8');
      const graph: RepoGraph = JSON.parse(raw);
      this.graphs.push(graph);
      // Index nodes
      for (const node of graph.nodes) {
        this.nodeIndex.set(node.id, node);
      }
      // Index edges
      for (const edge of graph.edges) {
        if (!this.edgesFromIndex.has(edge.from)) this.edgesFromIndex.set(edge.from, []);
        this.edgesFromIndex.get(edge.from)!.push(edge);
        if (!this.edgesToIndex.has(edge.to)) this.edgesToIndex.set(edge.to, []);
        this.edgesToIndex.get(edge.to)!.push(edge);
      }
    }

    // Load cross-repo
    const crossPath = path.join(codegraphDir, 'cross-repo.json');
    if (fs.existsSync(crossPath)) {
      const raw = fs.readFileSync(crossPath, 'utf8');
      this.crossRepo = JSON.parse(raw);
      // Index cross-repo edges too
      for (const edge of this.crossRepo.edges) {
        if (!this.edgesFromIndex.has(edge.from)) this.edgesFromIndex.set(edge.from, []);
        this.edgesFromIndex.get(edge.from)!.push(edge);
        if (!this.edgesToIndex.has(edge.to)) this.edgesToIndex.set(edge.to, []);
        this.edgesToIndex.get(edge.to)!.push(edge);
      }
    }

    return { repos: this.graphs, crossRepo: this.crossRepo };
  }

  allNodes(): GraphNode[] {
    return Array.from(this.nodeIndex.values());
  }

  nodeById(id: string): GraphNode | undefined {
    return this.nodeIndex.get(id);
  }

  edgesFrom(nodeId: string): GraphEdge[] {
    return this.edgesFromIndex.get(nodeId) ?? [];
  }

  edgesTo(nodeId: string): GraphEdge[] {
    return this.edgesToIndex.get(nodeId) ?? [];
  }

  nodesByKind(kind: NodeKind): GraphNode[] {
    return this.allNodes().filter(n => n.kind === kind);
  }

  nodesByRepo(repo: string): GraphNode[] {
    return this.allNodes().filter(n => n.repo === repo);
  }

  search(query: string, kind?: NodeKind, repo?: string): GraphNode[] {
    const q = query.toLowerCase();
    return this.allNodes().filter(n => {
      if (kind && n.kind !== kind) return false;
      if (repo && n.repo !== repo) return false;
      return n.name.toLowerCase().includes(q) || n.file.toLowerCase().includes(q);
    });
  }

  getGraphs(): RepoGraph[] {
    return this.graphs;
  }

  getCrossRepo(): CrossRepoGraph {
    return this.crossRepo;
  }

  isLoaded(): boolean {
    return this.graphs.length > 0;
  }

  // BFS traversal from a node, following edge direction
  bfsFrom(startId: string, maxDepth: number = 4): Map<string, GraphNode> {
    const visited = new Map<string, GraphNode>();
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      const node = this.nodeById(id);
      if (node) {
        visited.set(id, node);
        if (depth < maxDepth) {
          for (const edge of this.edgesFrom(id)) {
            if (!visited.has(edge.to)) {
              queue.push({ id: edge.to, depth: depth + 1 });
            }
          }
        }
      }
    }
    return visited;
  }
}
