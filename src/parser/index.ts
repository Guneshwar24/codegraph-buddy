import { glob } from 'glob';
import * as path from 'node:path';
import { parsePythonFile } from './python.js';
import { parseTypeScriptFile } from './typescript.js';
import type { RepoGraph, GraphNode, GraphEdge } from '../types.js';

// Glob patterns to ignore
const IGNORE_PATTERNS = [
  'node_modules/**',
  '.venv/**',
  'venv/**',
  '__pycache__/**',
  'dist/**',
  '.next/**',
  'alembic/versions/**',
  '*.min.js',
  'coverage/**',
  '.git/**',
];

export async function parseRepo(repoPath: string, repoName: string): Promise<RepoGraph> {
  const startTime = Date.now();

  // Find all Python and TypeScript files
  const files = await glob('**/*.{py,ts,tsx}', {
    cwd: repoPath,
    ignore: IGNORE_PATTERNS,
    absolute: false,
  });

  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];

  for (const relFile of files) {
    const absPath = path.join(repoPath, relFile);
    const ext = path.extname(relFile);

    let parsed: { nodes: GraphNode[]; edges: GraphEdge[] };

    if (ext === '.py') {
      parsed = parsePythonFile(absPath, relFile, repoName);
    } else if (ext === '.tsx') {
      parsed = parseTypeScriptFile(absPath, relFile, repoName, true);
    } else {
      parsed = parseTypeScriptFile(absPath, relFile, repoName, false);
    }

    allNodes.push(...parsed.nodes);
    allEdges.push(...parsed.edges);
  }

  return {
    repo: repoName,
    repoPath,
    builtAt: new Date().toISOString(),
    fileCount: files.length,
    nodes: allNodes,
    edges: allEdges,
  };
}
