# codegraph

Cross-repo code knowledge graph MCP server for the bidbuddy codebase.

## Setup

```bash
npm install
npm run build
```

## Usage

```bash
# Parse all three bidbuddy repos and write .codegraph/*.json
node dist/cli.js build

# Start MCP server (stdio transport)
node dist/cli.js serve

# Show graph stats
node dist/cli.js status
```

## Claude Code Integration

Add to `/Users/guni/Documents/bidbuddy/.mcp.json`:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/Users/guni/Documents/bidbuddy/codegraph/dist/cli.js", "serve"],
      "description": "Bidbuddy cross-repo code knowledge graph"
    }
  }
}
```

Then run `node dist/cli.js build` before each Claude Code session.
