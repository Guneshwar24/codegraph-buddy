# codegraph-buddy

> **Stop reading files. Start reading structure.**

A zero-dependency, zero-cloud MCP server that builds a queryable knowledge graph of your entire codebase using AST parsing — not vector embeddings. Built specifically for navigating complex multi-repo AI agent codebases with Claude Code.

---

## The Problem

When Claude Code tries to understand a large codebase, it reads files. Lots of files. For a three-repo setup like bidbuddy (829 files, ~220K lines), that burns 8,000–12,000 tokens just to answer "how does authentication work?" — and it still misses the call chains.

Vector search tools (Greptile, Sourcegraph Cody, Cursor's indexing) are better, but they capture **similarity**, not **structure**. They'll find 15 chunks mentioning "auth" and "token". What they miss is that `middleware.ts` calls `refresh.ts`, which depends on `jwt-config.ts`. The actual architecture is invisible to embeddings.

---

## The Solution

**codegraph-buddy** parses your repos with language-aware AST parsers (tree-sitter), builds a structural knowledge graph of nodes and edges, and exposes it to Claude Code via 8 progressive-depth MCP tools.

```
Ask: "How does the RAG agent work?"

Without codegraph:  Read 20+ files → 10,000 tokens → maybe get the answer
With codegraph:     list_agents → get_symbol → get_source → 800 tokens → precise answer
```

The result: **40–95% token reduction** on codebase comprehension tasks. Same answer quality. No cloud. No embeddings. No latency from inference steps. Just structure.

---

## Why AST over Embeddings

| | Vector Embeddings | codegraph-buddy (AST) |
|---|---|---|
| **Finds** | Semantically similar code | Exact call chains and dependencies |
| **Misses** | Structural relationships | Semantic similarity |
| **Latency** | 100–500ms per query | <5ms (in-memory graph) |
| **Cloud required** | Yes (for embedding model) | No |
| **Cross-repo linking** | Not typically | Yes — HTTP + import edges |
| **LangGraph aware** | No | Yes — agent topology extracted |
| **Token cost** | High (retrieves chunks) | Low (returns structured metadata) |

---

## Features

### Structural Parsing
- **Python**: functions, classes, methods, FastAPI route decorators, imports
- **TypeScript/TSX**: functions, classes, types, interfaces, Next.js route handlers, imports
- **20+ node kinds** covering every entity type in your codebase

### LangGraph Agent Topology
Understands `StateGraph` definitions out of the box:

```python
workflow = StateGraph(AgentState)
workflow.add_node("retrieve", retrieve_docs)
workflow.add_node("grade", grade_docs)
workflow.add_edge("retrieve", "grade")
```

Becomes a rich agent node:
```json
{
  "name": "workflow",
  "kind": "agent",
  "meta": {
    "agentType": "StateGraph",
    "agentNodes": ["retrieve", "grade", "generate"],
    "agentEdges": [{ "from": "retrieve", "to": "grade" }]
  }
}
```

### Cross-Repo Linking
Automatically stitches relationships across repos:
- **HTTP edges**: `frontend fetch('/api/agents/run')` → `agent-backend POST /api/agents/run`
- **Import edges**: `agent-backend` imports → `markethub-backend` modules

### 8 Progressive-Depth MCP Tools

| Tool | What it returns | ~Tokens |
|---|---|---|
| `shake` | All repos: file counts, node counts by kind | ~300 |
| `architecture_map` | Cross-repo dependency graph, package-level | ~600 |
| `repo_summary` | One repo: all routes, agents, classes, functions | ~800 |
| `list_agents` | All LangGraph agents with full node/edge topology | ~400 |
| `trace_request` | URL path → frontend → API route → agent → downstream | ~500 |
| `get_symbol` | One symbol: definition, callers, callees | ~300 |
| `search` | Symbol search with kind + repo filters | ~400 |
| `get_source` | Actual source lines (last resort) | varies |

Claude Code uses them in order — broad to narrow — never reading a file until it genuinely needs the source code.

---

## Architecture

```
codegraph-buddy/
├── src/
│   ├── cli.ts                  ← build | serve | status commands
│   ├── types.ts                ← GraphNode, GraphEdge, RepoGraph types
│   ├── parser/
│   │   ├── index.ts            ← repo walker (glob + dispatch)
│   │   ├── python.ts           ← tree-sitter-python + LangGraph detection
│   │   └── typescript.ts       ← tree-sitter-typescript + fetch() detection
│   ├── graph/
│   │   ├── builder.ts          ← per-repo graph assembly
│   │   ├── cross-repo.ts       ← HTTP + import cross-repo edge stitching
│   │   └── writer.ts           ← JSON output writer
│   └── server/
│       ├── index.ts            ← McpServer + StdioServerTransport
│       ├── loader.ts           ← in-memory graph with BFS traversal
│       └── tools.ts            ← 8 MCP tool registrations (Zod schemas)
└── .codegraph/                 ← generated output (gitignored)
    ├── agent-backend.json
    ├── markethub-backend.json
    ├── frontend-next.json
    └── cross-repo.json
```

**Data model:**
```
GraphNode { id, kind, name, file, repo, startLine, endLine, meta? }
GraphEdge { from, to, kind, crossRepo }

NodeKind:  function | class | method | type | interface |
           route | agent | agent_node | file | package

EdgeKind:  calls | imports | extends | implements |
           http_calls | agent_edge | depends_on
```

---

## Installation

### Prerequisites
- Node.js 20+
- Your repos cloned locally

### Setup

```bash
# Clone alongside your repos
cd /path/to/your/projects
git clone https://github.com/Guneshwar24/codegraph-buddy.git codegraph
cd codegraph

npm install
npm run build
```

### Configure repo paths

Edit `src/graph/builder.ts` to point to your repos:

```typescript
export function getBidbuddyRepos(baseDir: string): RepoConfig[] {
  return [
    { name: 'agent-backend',     path: path.join(baseDir, 'your-agent-backend') },
    { name: 'markethub-backend', path: path.join(baseDir, 'your-data-backend') },
    { name: 'frontend-next',     path: path.join(baseDir, 'your-frontend') },
  ];
}
```

Rebuild after changing: `npm run build`

---

## Usage

```bash
# Parse all repos and write .codegraph/*.json (run before each session)
node dist/cli.js build

# Show graph stats
node dist/cli.js status

# Start MCP server (used by Claude Code)
node dist/cli.js serve
```

### Claude Code Integration

Add to your `.mcp.json` (in the parent folder containing your repos):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph/dist/cli.js", "serve"],
      "description": "Cross-repo code knowledge graph"
    }
  }
}
```

Then restart Claude Code. The 8 tools will be available immediately.

**Recommended workflow:**
```bash
# Before starting a Claude Code session
node dist/cli.js build   # ~10s for 800 files
# Open Claude Code → tools auto-connect
```

---

## Real Numbers (bidbuddy codebase)

Parsed 829 files across 3 repos in **11.6 seconds**:

| Repo | Files | Nodes | Edges |
|---|---|---|---|
| agent-backend | 172 | 904 | 871 |
| markethub-backend | 50 | 329 | 316 |
| frontend-next | 607 | 2,065 | 2,316 |
| **cross-repo** | — | — | **26** |
| **Total** | **829** | **3,298** | **3,529** |

13 LangGraph agents fully mapped with internal node/edge topology.
65 API routes detected (17 Python FastAPI + 36 Next.js + 12 markethub).

---

## How it Compares

| Tool | Approach | Cloud | Cross-repo | LangGraph | Token savings |
|---|---|---|---|---|---|
| **codegraph-buddy** | AST graph | No | Yes | Yes | 40–95% |
| Greptile | Embeddings | Yes | Partial | No | ~30% |
| Sourcegraph Cody | Embeddings + search | Yes | Yes | No | ~40% |
| Cursor indexing | Embeddings | Yes | No | No | ~30% |
| Codebase-Memory MCP | AST + SQLite (C binary) | No | No | No | 99%* |
| mcp-server-tree-sitter | AST (in-memory) | No | No | No | varies |
| Repomix | File packing | No | Manual | No | 0% (dumps everything) |

*Codebase-Memory achieves higher savings on generic repos; codegraph-buddy adds LangGraph awareness and cross-repo linking specific to multi-agent architectures.

---

## Design Decisions

**Why JSON files, not SQLite?**
Zero dependencies, human-readable, trivially debuggable. The graph for 829 files is ~2MB total — well within in-memory comfort. SQLite is a natural next step when the graph grows.

**Why tree-sitter, not regex?**
Regex breaks on nested structures, decorators, and multiline expressions. tree-sitter produces a real AST — the same parser your IDE uses for autocomplete. FastAPI route decorators and LangGraph `add_node` calls are impossible to reliably detect with regex.

**Why STDIO transport?**
Claude Code spawns MCP servers as local processes via stdio. No port conflicts, no auth, zero network overhead. Each Claude Code session gets a fresh server process with the graph loaded from disk.

**Why no embeddings?**
Embeddings answer "what is similar to X?" — which is valuable but not what you need most when navigating a codebase. You need "what calls X?", "what does X depend on?", "what is the full request path for /api/Y?". Those are structural questions. The graph answers them precisely in <5ms with zero inference cost.

---

## Extending

### Add a new language

1. Install the tree-sitter grammar: `npm install tree-sitter-go`
2. Create `src/parser/go.ts` following the pattern in `python.ts`
3. Add the extension dispatch in `src/parser/index.ts`
4. Rebuild

### Add a new MCP tool

In `src/server/tools.ts`, add a new `server.tool()` call:
```typescript
server.tool(
  'my_tool',
  'Description of what this tool does',
  { param: z.string().describe('What this param does') },
  async ({ param }) => {
    const result = loader.search(param);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }
);
```

Rebuild and restart Claude Code.

---

## Contributing

Issues and PRs welcome. If you add LangGraph support for a different agent framework (CrewAI, AutoGen, etc.) or cross-repo linking for a different stack, open a PR.

---

## License

MIT — use it, fork it, build on it.

---

*Built for the [bidbuddy](https://github.com/Guneshwar24) codebase. Inspired by [CartoGopher / CodeGraphProtocol](https://medium.com/) by Jake Nesler and [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) by DeusData.*
