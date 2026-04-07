import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { GraphLoader } from './loader.js';
import { registerTools } from './tools.js';

export async function startServer(codegraphDir: string): Promise<void> {
  const loader = new GraphLoader();

  try {
    loader.load(codegraphDir);
    console.error(`[codegraph] Graph loaded: ${loader.getGraphs().length} repos, ${loader.allNodes().length} nodes`);
  } catch (err) {
    console.error(`[codegraph] Warning: Could not load graph: ${err}`);
    console.error(`[codegraph] Run 'codegraph build' to generate the graph first.`);
    // Don't exit — still start server so tools return helpful error messages
  }

  const server = new McpServer({
    name: 'codegraph',
    version: '0.1.0',
  });

  registerTools(server, loader);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[codegraph] MCP server running on stdio');
}
