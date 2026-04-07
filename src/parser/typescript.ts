import { readFileSync } from 'fs';
import Parser from 'tree-sitter';
import TSLanguages from 'tree-sitter-typescript';
import type { GraphNode, GraphEdge, NodeKind } from '../types.js';

// tree-sitter ships as CJS; access Query via the Parser namespace
const { Query } = Parser as unknown as { Query: new (lang: unknown, src: string) => TSQuery };

// tree-sitter-typescript exports both typescript and tsx grammars
const { typescript: TypeScript, tsx: TSX } = TSLanguages as any;

interface TSCapture {
  name: string;
  node: TSNode;
}

interface TSQuery {
  captures(node: TSNode): TSCapture[];
  matches(node: TSNode): Array<{ pattern: number; captures: TSCapture[] }>;
}

interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent: TSNode | null;
  children: TSNode[];
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
}

export interface ParsedFile {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function nodeId(repo: string, relPath: string, symbol: string): string {
  return `${repo}::${relPath}::${symbol}`;
}

function isInsideClass(node: TSNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'class_declaration' || parent.type === 'class_body') return true;
    parent = parent.parent;
  }
  return false;
}

/** Walk the tree recursively, calling visitor for each node. */
function walk(node: TSNode, visitor: (n: TSNode) => void): void {
  visitor(node);
  for (const child of node.children) {
    walk(child, visitor);
  }
}

// ── Next.js route detection ───────────────────────────────────────────────────

const NEXTJS_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/**
 * Returns true if this file is likely a Next.js route handler.
 * Matches files under app/ or pages/api/ directories.
 */
function isRouteFile(relPath: string): boolean {
  return relPath.includes('/app/') || relPath.startsWith('app/') ||
    relPath.includes('/pages/api/') || relPath.startsWith('pages/api/');
}

/**
 * Infer the HTTP path from the file path.
 * e.g. "src/app/api/agents/route.ts" → "/api/agents"
 *      "pages/api/users/[id].ts"     → "/api/users/[id]"
 */
function inferHttpPath(relPath: string): string {
  // Normalize slashes
  let p = relPath.replace(/\\/g, '/');

  // Strip app/ prefix (keep everything after it)
  const appIdx = p.indexOf('/app/');
  if (appIdx !== -1) {
    p = p.slice(appIdx + '/app/'.length - 1); // keep leading /
  } else if (p.startsWith('app/')) {
    p = '/' + p.slice('app/'.length);
  }

  const pagesApiIdx = p.indexOf('/pages/api/');
  if (pagesApiIdx !== -1) {
    p = p.slice(pagesApiIdx + '/pages/'.length - 1);
  } else if (p.startsWith('pages/')) {
    p = '/' + p.slice('pages/'.length);
  }

  // Strip route.ts / route.tsx / page.tsx suffix
  p = p.replace(/\/route\.(ts|tsx)$/, '');
  // Strip file extension for pages/api style
  p = p.replace(/\.(ts|tsx|js|jsx)$/, '');
  // Strip trailing slash
  p = p.replace(/\/$/, '') || '/';

  return p;
}

/**
 * Check if a function_declaration node is exported (has `export` modifier).
 * In tree-sitter-typescript the export wrapper is `export_statement` which
 * wraps the declaration.
 */
function isExported(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return parent.type === 'export_statement';
}

// ── fetch() call detection ────────────────────────────────────────────────────

/**
 * If a call_expression is `fetch('/api/...')`, return the URL string.
 * Handles string literals and template literals starting with `/api/`.
 */
function parseFetchCall(node: TSNode): string | null {
  if (node.type !== 'call_expression') return null;

  const fn = node.childForFieldName('function');
  if (!fn || fn.text !== 'fetch') return null;

  const args = node.childForFieldName('arguments');
  if (!args) return null;

  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;

  // String literal: 'string' node contains a 'string_fragment' child
  if (firstArg.type === 'string') {
    const fragment = firstArg.children.find(c => c.type === 'string_fragment');
    const val = fragment ? fragment.text : firstArg.text.slice(1, -1);
    if (val.startsWith('/api/')) return val;
    return null;
  }

  // Template literal: `template_string` — grab raw text between backticks
  if (firstArg.type === 'template_string') {
    // The text includes surrounding backticks; strip them
    const raw = firstArg.text.slice(1, -1);
    // Only handle the static prefix before any interpolation
    const staticPart = raw.split('${')[0];
    if (staticPart.startsWith('/api/')) return staticPart;
    return null;
  }

  return null;
}

// ── main export ───────────────────────────────────────────────────────────────

export function parseTypeScriptFile(
  absolutePath: string,
  relativeFilePath: string,
  repo: string,
  isTSX?: boolean
): ParsedFile {
  try {
    const sourceCode = readFileSync(absolutePath, 'utf8');
    const language = isTSX ? TSX : TypeScript;

    const parser = new (Parser as unknown as new () => InstanceType<typeof Parser>)();
    (parser as unknown as { setLanguage(l: unknown): void }).setLanguage(language);
    const tree = (parser as unknown as { parse(src: string): { rootNode: TSNode } }).parse(sourceCode);
    const root = tree.rootNode;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const fileId = nodeId(repo, relativeFilePath, '__file__');
    const routeFile = isRouteFile(relativeFilePath);
    const httpPath = routeFile ? inferHttpPath(relativeFilePath) : '';

    // ── 1. Function declarations ──────────────────────────────────────────────

    const fnQuery = new Query(
      language,
      '(function_declaration name: (identifier) @name)'
    ) as TSQuery;

    for (const cap of fnQuery.captures(root)) {
      const nameNode = cap.node;
      const fnNode = nameNode.parent; // function_declaration
      if (!fnNode) continue;

      const name = nameNode.text;
      const inClass = isInsideClass(fnNode);

      // Determine if this is a Next.js route handler
      const isRoute = routeFile && !inClass && NEXTJS_HTTP_METHODS.has(name) && isExported(fnNode);
      const kind: NodeKind = isRoute ? 'route' : inClass ? 'method' : 'function';

      // The effective container node (export_statement wraps the fn for exports)
      const containerNode = isExported(fnNode) ? fnNode.parent! : fnNode;

      const n: GraphNode = {
        id: nodeId(repo, relativeFilePath, name),
        kind,
        name,
        file: relativeFilePath,
        repo,
        startLine: containerNode.startPosition.row + 1,
        endLine: containerNode.endPosition.row + 1,
      };

      if (isRoute) {
        n.meta = {
          httpMethod: name,
          httpPath,
        };
      }

      nodes.push(n);
    }

    // ── 2. Arrow functions assigned to variables ──────────────────────────────

    const arrowQuery = new Query(
      language,
      '(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function)))'
    ) as TSQuery;

    for (const cap of arrowQuery.captures(root)) {
      const nameNode = cap.node;
      const declaratorNode = nameNode.parent; // variable_declarator
      if (!declaratorNode) continue;
      const lexicalDecl = declaratorNode.parent; // lexical_declaration
      if (!lexicalDecl) continue;

      const name = nameNode.text;
      const inClass = isInsideClass(lexicalDecl);
      const kind: NodeKind = inClass ? 'method' : 'function';

      // Container might be an export_statement
      const containerNode = isExported(lexicalDecl) ? lexicalDecl.parent! : lexicalDecl;

      nodes.push({
        id: nodeId(repo, relativeFilePath, name),
        kind,
        name,
        file: relativeFilePath,
        repo,
        startLine: containerNode.startPosition.row + 1,
        endLine: containerNode.endPosition.row + 1,
      });
    }

    // ── 3. Classes ────────────────────────────────────────────────────────────

    const classQuery = new Query(
      language,
      '(class_declaration name: (type_identifier) @name)'
    ) as TSQuery;

    for (const cap of classQuery.captures(root)) {
      const nameNode = cap.node;
      const classNode = nameNode.parent;
      if (!classNode) continue;

      const name = nameNode.text;
      const containerNode = isExported(classNode) ? classNode.parent! : classNode;

      nodes.push({
        id: nodeId(repo, relativeFilePath, name),
        kind: 'class',
        name,
        file: relativeFilePath,
        repo,
        startLine: containerNode.startPosition.row + 1,
        endLine: containerNode.endPosition.row + 1,
      });
    }

    // ── 4. Type aliases ───────────────────────────────────────────────────────

    const typeQuery = new Query(
      language,
      '(type_alias_declaration name: (type_identifier) @name)'
    ) as TSQuery;

    for (const cap of typeQuery.captures(root)) {
      const nameNode = cap.node;
      const typeNode = nameNode.parent;
      if (!typeNode) continue;

      const name = nameNode.text;
      const containerNode = isExported(typeNode) ? typeNode.parent! : typeNode;

      nodes.push({
        id: nodeId(repo, relativeFilePath, name),
        kind: 'type',
        name,
        file: relativeFilePath,
        repo,
        startLine: containerNode.startPosition.row + 1,
        endLine: containerNode.endPosition.row + 1,
      });
    }

    // ── 5. Interfaces ─────────────────────────────────────────────────────────

    const interfaceQuery = new Query(
      language,
      '(interface_declaration name: (type_identifier) @name)'
    ) as TSQuery;

    for (const cap of interfaceQuery.captures(root)) {
      const nameNode = cap.node;
      const ifaceNode = nameNode.parent;
      if (!ifaceNode) continue;

      const name = nameNode.text;
      const containerNode = isExported(ifaceNode) ? ifaceNode.parent! : ifaceNode;

      nodes.push({
        id: nodeId(repo, relativeFilePath, name),
        kind: 'interface',
        name,
        file: relativeFilePath,
        repo,
        startLine: containerNode.startPosition.row + 1,
        endLine: containerNode.endPosition.row + 1,
      });
    }

    // ── 6. Methods inside classes ─────────────────────────────────────────────

    const methodQuery = new Query(
      language,
      '(method_definition name: (property_identifier) @name)'
    ) as TSQuery;

    for (const cap of methodQuery.captures(root)) {
      const nameNode = cap.node;
      const methodNode = nameNode.parent;
      if (!methodNode) continue;

      const name = nameNode.text;

      nodes.push({
        id: nodeId(repo, relativeFilePath, name),
        kind: 'method',
        name,
        file: relativeFilePath,
        repo,
        startLine: methodNode.startPosition.row + 1,
        endLine: methodNode.endPosition.row + 1,
      });
    }

    // ── 7. fetch() calls (http_calls edges) ───────────────────────────────────

    walk(root, (n) => {
      const url = parseFetchCall(n);
      if (url) {
        edges.push({
          from: fileId,
          to: url,
          kind: 'http_calls',
          crossRepo: true,
        });
      }
    });

    // ── 8. Imports ────────────────────────────────────────────────────────────

    const importQuery = new Query(
      language,
      '(import_statement source: (string (string_fragment) @source))'
    ) as TSQuery;

    for (const cap of importQuery.captures(root)) {
      const sourceNode = cap.node;
      edges.push({
        from: fileId,
        to: sourceNode.text,
        kind: 'imports',
        crossRepo: false,
      });
    }

    return { nodes, edges };
  } catch (err) {
    console.error('[codegraph] Failed to parse TypeScript file', relativeFilePath, err);
    return { nodes: [], edges: [] };
  }
}
