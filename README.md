# codegraph-buddy

> **Stop reading files. Start reading structure.**

A zero-dependency, zero-cloud MCP server that builds a queryable knowledge graph of your entire codebase using AST parsing — not vector embeddings. Built for navigating complex multi-repo AI agent codebases with Claude Code.

---

## The Problem

When Claude Code tries to understand a large codebase, it reads files. Lots of files. For a three-repo setup with 800+ files, that burns 8,000–12,000 tokens just to answer "how does authentication work?" — and it still misses the call chains.

Vector search tools (Greptile, Sourcegraph Cody, Cursor's indexing) are better, but they capture **similarity**, not **structure**. They'll find 15 chunks mentioning "auth" and "token". What they miss is that `middleware.ts` calls `refresh.ts`, which depends on `jwt-config.ts`. The actual architecture is invisible to embeddings.

---

## The Solution

**codegraph-buddy** parses your repos with language-aware AST parsers (tree-sitter), builds a structural knowledge graph of nodes and edges, and exposes it to Claude Code via 8 progressive-depth MCP tools.

```
Ask: "How does the RAG agent work?"

Without codegraph:  Read 20+ files → many thousands of tokens → maybe get the answer
With codegraph:     list_agents → get_symbol → get_source → structured answer
```

No cloud. No embeddings. No latency from inference steps. Just structure.

> **Benchmark it yourself.** In practice I found token usage dropped significantly — anywhere from 40% to 65% depending on task complexity and how many repos are involved. Your mileage will vary. Run your own sessions with and without and see.

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
| **Token cost** | High (retrieves chunks) | Lower (returns structured metadata) |

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
- **HTTP edges**: `frontend fetch('/api/agents/run')` → `backend POST /api/agents/run`
- **Import edges**: one backend service importing from another

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
├── codegraph.config.json       ← your repo paths go here
├── src/
│   ├── cli.ts                  ← build | serve | status | init commands
│   ├── types.ts                ← GraphNode, GraphEdge, RepoGraph types
│   ├── parser/
│   │   ├── index.ts            ← repo walker (glob + dispatch)
│   │   ├── python.ts           ← tree-sitter-python + LangGraph detection
│   │   └── typescript.ts       ← tree-sitter-typescript + fetch() detection
│   ├── graph/
│   │   ├── builder.ts          ← config loading + per-repo graph assembly
│   │   ├── cross-repo.ts       ← HTTP + import cross-repo edge stitching
│   │   └── writer.ts           ← JSON output writer
│   └── server/
│       ├── index.ts            ← McpServer + StdioServerTransport
│       ├── loader.ts           ← in-memory graph with BFS traversal
│       └── tools.ts            ← 8 MCP tool registrations (Zod schemas)
└── .codegraph/                 ← generated output (gitignored)
    ├── my-backend.json
    ├── my-frontend.json
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
git clone https://github.com/Guneshwar24/codegraph-buddy.git
cd codegraph-buddy

npm install
npm run build
```

---

## Configuration

Run `codegraph init` in the folder containing your repos to generate a starter config:

```bash
cd /path/to/your/projects
node /path/to/codegraph-buddy/dist/cli.js init
```

This creates `codegraph.config.json`:

```json
{
  "repos": [
    { "name": "my-backend",  "path": "../my-backend" },
    { "name": "my-frontend", "path": "../my-frontend" }
  ],
  "output": ".codegraph"
}
```

Paths are **relative to the config file** or absolute. Add as many repos as you need.

---

## Usage

```bash
# Parse all repos defined in codegraph.config.json
node dist/cli.js build

# Show graph stats from last build
node dist/cli.js status

# Start MCP server (used by Claude Code)
node dist/cli.js serve

# Create a starter config in the current directory
node dist/cli.js init

# Use a specific config file
node dist/cli.js build --config /path/to/codegraph.config.json
```

### Claude Code Integration

Add to your `.mcp.json` (in the parent folder containing your repos):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph-buddy/dist/cli.js", "serve"],
      "description": "Cross-repo code knowledge graph"
    }
  }
}
```

Restart Claude Code. The 8 tools will be available immediately.

**Recommended workflow:**
```bash
# Before starting a Claude Code session
node dist/cli.js build   # ~10s for 800 files
# Open Claude Code → tools auto-connect
```

### The Skill: Teaching Claude How to Use the Tools

Having the MCP tools available is only half the picture. The other half is making sure Claude uses them in the right order.

**Without the skill:** Claude knows the 8 codegraph tools exist, but decides on its own whether to use them, when, and in what order. It might skip `shake` and jump straight to reading files out of habit — which burns tokens.

**With the skill:** Claude follows an explicit playbook every session — always starting broad, drilling narrow, and never touching a file until the graph can't answer the question.

| Rule | Why it matters |
|---|---|
| Always call `shake` first | Orients Claude in ~300 tokens before anything else |
| Follow the 8-step depth ladder | Broad → narrow, stops as soon as it has enough |
| Never use `Grep` to find symbols | Use `search` instead — structured, cheaper |
| Never read an agent `.py` file without `list_agents` first | The graph already has the full topology |
| `get_source` is last resort only | Actual file reading is the most expensive thing |

**Install the skill** by saving `SKILL.md` to `~/.claude/skills/codegraph-buddy/SKILL.md`:

```bash
mkdir -p ~/.claude/skills/codegraph-buddy
curl -o ~/.claude/skills/codegraph-buddy/SKILL.md \
  https://raw.githubusercontent.com/Guneshwar24/codegraph-buddy/main/skill/SKILL.md
```

The skill auto-activates whenever you're working in a multi-repo codebase. You can also invoke it explicitly with `/codegraph-buddy` in any Claude Code session.

---

## Real-World Numbers

Example run on a 3-repo multi-agent codebase (Python API backend + Python data pipeline + TypeScript/Next.js frontend):

| Repo | Files | Nodes | Edges |
|---|---|---|---|
| python-backend | 172 | 904 | 871 |
| data-pipeline | 50 | 329 | 316 |
| nextjs-frontend | 607 | 2,065 | 2,316 |
| **cross-repo** | — | — | **26** |
| **Total** | **829** | **3,298** | **3,529** |

- Build time: **11.6 seconds**
- 13 LangGraph agents fully mapped with internal node/edge topology
- 65 API routes detected across all repos

---

## How it Compares

| Tool | Approach | Cloud | Cross-repo | LangGraph |
|---|---|---|---|---|
| **codegraph-buddy** | AST graph | No | Yes | Yes |
| Greptile | Embeddings | Yes | Partial | No |
| Sourcegraph Cody | Embeddings + search | Yes | Yes | No |
| Cursor indexing | Embeddings | Yes | No | No |
| Codebase-Memory MCP | AST + SQLite (C binary) | No | No | No |
| mcp-server-tree-sitter | AST (in-memory) | No | No | No |
| Repomix | File packing | No | Manual | No |

---

## Design Decisions

**Why JSON files, not SQLite?**
Zero dependencies, human-readable, trivially debuggable. The graph for 800+ files is ~2MB total — well within in-memory comfort. SQLite is a natural next step when the graph grows beyond that.

**Why tree-sitter, not regex?**
Regex breaks on nested structures, decorators, and multiline expressions. tree-sitter produces a real AST — the same parser your IDE uses for autocomplete. FastAPI route decorators and LangGraph `add_node` calls are impossible to reliably detect with regex.

**Why STDIO transport?**
Claude Code spawns MCP servers as local processes via stdio. No port conflicts, no auth, zero network overhead. Each Claude Code session gets a fresh server process with the graph loaded from disk.

**Why no embeddings?**
Embeddings answer "what is similar to X?" — valuable, but not what you need most when navigating a codebase. You need "what calls X?", "what does X depend on?", "what is the full request path for /api/Y?". Those are structural questions. The graph answers them precisely in <5ms with zero inference cost.

---

## Extending

### Add a new language

1. Install the tree-sitter grammar: `npm install tree-sitter-go`
2. Create `src/parser/go.ts` following the pattern in `python.ts`
3. Add the extension dispatch in `src/parser/index.ts`
4. Rebuild

### Add a new MCP tool

In `src/server/tools.ts`:
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

Issues and PRs welcome. If you add:
- LangGraph support for other agent frameworks (CrewAI, AutoGen, etc.)
- Cross-repo linking for other stacks
- New language parsers
- SQLite persistence layer

...open a PR.

---

## License

MIT — use it, fork it, build on it.

---

*Inspired by [CartoGopher / CodeGraphProtocol](https://medium.com/) by Jake Nesler and [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) by DeusData.*
