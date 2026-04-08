---
name: codegraph-buddy
description: Navigate the bidbuddy codebase using the codegraph MCP knowledge graph. Enforces progressive-depth tool usage to minimize token consumption — always graph first, files last.
origin: local
---

# codegraph-buddy Navigation Skill

Rules for using the codegraph MCP server to navigate the bidbuddy codebase (agent-backend, markethub-backend, frontend-next) with maximum token efficiency.

## The Golden Rule

**Never read a file until the graph can't answer the question.**

The graph returns structured metadata in ~300–800 tokens. Reading a file costs 500–5,000 tokens. Every file read you avoid is a win.

## When to Activate

Activate this skill whenever you are:
- Starting a new session in the bidbuddy codebase
- Asked to understand how something works
- Debugging a feature that spans multiple repos
- Tracing a request from frontend to backend
- Looking for where a function, class, or route is defined
- Trying to understand a LangGraph agent's flow
- Making changes that affect multiple repos

## Mandatory Session Start

**The first thing you do in any bidbuddy session is call `shake`.**

```
Tool: shake
(no arguments)
```

This gives you the codebase overview in ~300 tokens. Never skip this — it orients every subsequent decision and costs almost nothing.

## Progressive Depth — Always Follow This Order

Work from broad to narrow. Stop as soon as you have enough information.

```
1. shake              → What exists across all 3 repos?
2. architecture_map   → How do the repos connect to each other?
3. repo_summary       → What's in this specific repo?
4. list_agents        → What LangGraph agents exist and what are their steps?
5. trace_request      → How does a specific URL path flow through the stack?
6. get_symbol         → What is this specific function/class and who calls it?
7. search             → Find symbols by name or partial match
8. get_source         → (LAST RESORT) Read the actual source lines
```

Never jump straight to step 8. Never call `get_source` before trying `get_symbol` first.

## Tool Usage Guide

### `shake` — Always first
```
When: Start of every session, or when asked for an overview
Returns: All 3 repos with file counts and node counts by kind
Cost: ~300 tokens
```

### `architecture_map` — Cross-repo questions
```
When: "How does X connect to Y?", "What calls what across repos?",
      "How does the frontend talk to the backend?"
Returns: Package-level cross-repo dependency graph
Cost: ~600 tokens
```

### `repo_summary` — Repo-level questions
```
When: "What routes does agent-backend have?", "What agents exist?",
      "Give me an overview of the frontend"
Args: repo = "agent-backend" | "markethub-backend" | "frontend-next"
Returns: All routes, agents, classes, top functions for that repo
Cost: ~800 tokens
```

### `list_agents` — LangGraph questions
```
When: "How does the RAG agent work?", "What steps does task_drafter have?",
      "Which agents exist?", anything about agent flows or LangGraph
Returns: All 13 agents with their internal node topology and edges
Cost: ~400 tokens — USE THIS before reading any agent Python file
```

### `trace_request` — Request tracing
```
When: "How does /api/agents/run work?", "Trace this endpoint end-to-end",
      "What happens when the frontend calls X?"
Args: path = "/api/agents/run" (the URL path)
Returns: Frontend callsite → API route → agent → downstream services
Cost: ~500 tokens — replaces reading 5–10 files
```

### `get_symbol` — Symbol lookup
```
When: "Where is RagAgent defined?", "What calls markethub_tender_search?",
      "Find the class that handles streaming"
Args: name = "RagAgent", repo = "agent-backend" (optional)
Returns: Definition location, callers, callees, line numbers
Cost: ~300 tokens — replaces grep + file read
```

### `search` — Discovery
```
When: You know part of a name but not the full name,
      "Find everything related to tender search",
      "What functions exist for CPV codes?"
Args: query = "tender", kind = "function" (optional), repo = "agent-backend" (optional)
Returns: Up to 30 matching nodes with file locations
Cost: ~400 tokens
```

### `get_source` — Last resort only
```
When: You need the actual implementation logic, not just the structure.
      Only after get_symbol told you WHERE it is and you still need HOW it works.
Args: nodeId = (from search or get_symbol results)
Returns: Actual source lines from the file
Cost: varies — this is the expensive one
```

## Common Workflows

### "Explain how [agent] works"
```
1. list_agents                          → find the agent, see its nodes/edges
2. get_symbol name="[agent_function]"   → find key functions
3. get_source nodeId="..."              → read implementation if still needed
```

### "How does the frontend call [feature]?"
```
1. architecture_map                     → confirm cross-repo connections
2. search query="[feature]" repo="frontend-next"  → find the callsite
3. trace_request path="/api/[route]"    → trace end-to-end
4. get_symbol name="[route_handler]"    → examine the backend handler
```

### "Where is [thing] defined?"
```
1. search query="[thing]"              → find candidates
2. get_symbol name="[thing]"           → confirm + get callers/callees
3. get_source nodeId="..."             → read if you need the implementation
```

### "What does [repo] do?"
```
1. repo_summary repo="[repo]"          → complete picture in one call
2. list_agents (if asking about agent-backend)  → agent details
3. get_symbol for specific items of interest
```

### "Make a change that affects multiple repos"
```
1. shake                               → orient yourself
2. architecture_map                    → understand the boundaries
3. trace_request for affected routes   → map the impact
4. get_symbol for each affected symbol → find all call sites
5. get_source only for what you'll edit
```

## What NOT To Do

```
❌ Reading files with the Read tool before trying graph tools
❌ Using Grep to search for function names (use search instead)
❌ Calling get_source without calling get_symbol first
❌ Skipping shake at session start
❌ Reading agent Python files without calling list_agents first
❌ Calling repo_summary for all 3 repos upfront — pick the relevant one
```

## Graph Limitations

The graph is a snapshot. It was last built when `codegraph build` was run.

- **Stale graph**: If you just added a new function and can't find it, rebuild: `node /Users/guni/Documents/bidbuddy/codegraph/dist/cli.js build`
- **Parse failures**: A small number of complex files may not be parsed — fall back to Read for those
- **Dynamic patterns**: Runtime-constructed route paths (f-strings, dynamic registration) may not be detected
- **Cross-repo edges**: Some fetch() calls may show as "unresolved" — that means they call Next.js API routes within frontend-next, not the Python backend

## Rebuilding the Graph

If the graph seems stale or you've made significant changes:
```bash
node /Users/guni/Documents/bidbuddy/codegraph/dist/cli.js build
```

Takes ~12 seconds. Do this at the start of a session if you've made major structural changes.
