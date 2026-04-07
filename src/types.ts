// Node kinds — every entity type in the codebase
export type NodeKind =
  | 'function'
  | 'class'
  | 'method'
  | 'type'
  | 'interface'
  | 'route'        // FastAPI @router.get/post/put/delete/patch
  | 'agent'        // LangGraph StateGraph instance
  | 'agent_node'   // node inside a StateGraph (.add_node)
  | 'file'
  | 'package';

// Edge kinds — every relationship type between nodes
export type EdgeKind =
  | 'calls'
  | 'imports'
  | 'extends'
  | 'implements'
  | 'http_calls'   // frontend fetch('/api/...') → backend route
  | 'agent_edge'   // LangGraph .add_edge / .add_conditional_edges
  | 'depends_on';

// A single entity extracted from the codebase
export interface GraphNode {
  id: string;         // "{repo}::{file}::{name}" e.g. "agent-backend::agents/rag_agent.py::RagAgent"
  kind: NodeKind;
  name: string;
  file: string;       // relative path within repo
  repo: string;       // "agent-backend" | "markethub-backend" | "frontend-next"
  startLine: number;
  endLine: number;
  meta?: {
    httpMethod?: string;       // "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
    httpPath?: string;         // "/api/agents/run"
    agentType?: string;        // "StateGraph" | "MessageGraph"
    agentNodes?: string[];     // ["retrieve", "grade_documents", "generate"]
    agentEdges?: Array<{
      from: string;
      to: string;
      conditional?: boolean;
    }>;
    decorator?: string;        // "@router.post" etc.
    returnType?: string;
    docstring?: string;
  };
}

// A relationship between two nodes
export interface GraphEdge {
  from: string;       // node ID
  to: string;         // node ID
  kind: EdgeKind;
  crossRepo: boolean;
}

// All nodes and edges for one repo
export interface RepoGraph {
  repo: string;
  repoPath: string;   // absolute path on disk
  builtAt: string;    // ISO timestamp
  fileCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Cross-repo linking edges only
export interface CrossRepoGraph {
  builtAt: string;
  repos: string[];
  edges: GraphEdge[];
}

// Combined in-memory structure used by the MCP server
export interface AllGraphs {
  repos: RepoGraph[];
  crossRepo: CrossRepoGraph;
}

// Config file schema (codegraph.config.json)
export interface RepoConfig {
  name: string;   // short identifier e.g. "agent-backend"
  path: string;   // path relative to config file, or absolute
}

export interface CodeGraphConfig {
  repos: RepoConfig[];
  output?: string;  // output dir, defaults to ".codegraph" next to config file
}
