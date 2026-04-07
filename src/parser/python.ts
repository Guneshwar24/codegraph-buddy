import { readFileSync } from 'fs';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import type { GraphNode, GraphEdge, NodeKind } from '../types.js';

// tree-sitter ships as CJS; access Query via the Parser namespace
const { Query } = Parser as unknown as { Query: new (lang: unknown, src: string) => TSQuery };

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
    if (parent.type === 'class_definition') return true;
    parent = parent.parent;
  }
  return false;
}

/** Extract the raw string value from a string node (strips quotes). */
function stringValue(node: TSNode): string {
  // node.text includes surrounding quotes; strip them
  const t = node.text;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t.startsWith('"""') && t.endsWith('"""')) return t.slice(3, -3);
  if (t.startsWith("'''") && t.endsWith("'''")) return t.slice(3, -3);
  return t;
}

/** Find the first child of a given type. */
function childOfType(node: TSNode, type: string): TSNode | null {
  return node.children.find(c => c.type === type) ?? null;
}

// ── FastAPI decorator detection ───────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);

interface RouteInfo {
  httpMethod: string;
  httpPath: string;
  decorator: string;
}

/**
 * If the decorator node (e.g. `@router.post("/path")`) is a FastAPI route
 * decorator, return route info; otherwise null.
 */
function parseRouteDecorator(decoratorNode: TSNode): RouteInfo | null {
  // decorator child structure: @<expr>
  // The decorator text is like: @router.post('/items')
  // child of decorator is a `call` node
  const callNode = decoratorNode.children.find(c => c.type === 'call');
  if (!callNode) return null;

  const funcNode = callNode.childForFieldName('function');
  if (!funcNode || funcNode.type !== 'attribute') return null;

  const attrNode = funcNode.childForFieldName('attribute');
  if (!attrNode) return null;

  const method = attrNode.text.toLowerCase();
  if (!HTTP_METHODS.has(method)) return null;

  const objectNode = funcNode.childForFieldName('object');
  const objectName = objectNode?.text ?? 'router';

  // Extract path from first argument
  const argsNode = callNode.childForFieldName('arguments');
  let httpPath = '';
  if (argsNode) {
    const firstArg = argsNode.namedChildren[0];
    if (firstArg && (firstArg.type === 'string' || firstArg.type.includes('string'))) {
      httpPath = stringValue(firstArg);
    }
  }

  return {
    httpMethod: method.toUpperCase(),
    httpPath,
    decorator: `@${objectName}.${method}`,
  };
}

// ── LangGraph detection helpers ───────────────────────────────────────────────

/**
 * If a statement is `varName = StateGraph(...)` or `varName = MessageGraph(...)`,
 * return { varName, agentType }.
 */
function parseStateGraphAssignment(node: TSNode): { varName: string; agentType: string } | null {
  if (node.type !== 'expression_statement') return null;
  const assign = childOfType(node, 'assignment');
  if (!assign) return null;

  const left = assign.childForFieldName('left');
  const right = assign.childForFieldName('right');
  if (!left || !right) return null;
  if (left.type !== 'identifier') return null;
  if (right.type !== 'call') return null;

  const fn = right.childForFieldName('function');
  if (!fn) return null;

  const fnName = fn.type === 'identifier' ? fn.text : null;
  if (fnName !== 'StateGraph' && fnName !== 'MessageGraph') return null;

  return { varName: left.text, agentType: fnName };
}

/**
 * If a statement is `something.add_node("name", fn)`, return { object, nodeName }.
 */
function parseAddNode(node: TSNode): { object: string; nodeName: string } | null {
  if (node.type !== 'expression_statement') return null;
  const call = childOfType(node, 'call');
  if (!call) return null;

  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return null;
  if (fn.childForFieldName('attribute')?.text !== 'add_node') return null;

  const obj = fn.childForFieldName('object')?.text;
  if (!obj) return null;

  const args = call.childForFieldName('arguments');
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;

  let nodeName = '';
  if (firstArg.type === 'string' || firstArg.type.includes('string')) {
    nodeName = stringValue(firstArg);
  } else {
    nodeName = firstArg.text;
  }

  return { object: obj, nodeName };
}

/**
 * If a statement is `something.add_edge("from", "to")`, return edge info.
 */
function parseAddEdge(node: TSNode): { object: string; from: string; to: string; conditional: boolean } | null {
  if (node.type !== 'expression_statement') return null;
  const call = childOfType(node, 'call');
  if (!call) return null;

  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return null;

  const attrText = fn.childForFieldName('attribute')?.text;
  const isConditional = attrText === 'add_conditional_edges';
  if (attrText !== 'add_edge' && !isConditional) return null;

  const obj = fn.childForFieldName('object')?.text;
  if (!obj) return null;

  const args = call.childForFieldName('arguments');
  if (!args) return null;
  const namedArgs = args.namedChildren;

  function argStr(n: TSNode): string {
    if (n.type === 'string' || n.type.includes('string')) return stringValue(n);
    return n.text;
  }

  const fromStr = namedArgs[0] ? argStr(namedArgs[0]) : '';
  const toStr = namedArgs[1] ? argStr(namedArgs[1]) : '';

  return { object: obj, from: fromStr, to: toStr, conditional: isConditional };
}

// ── main export ───────────────────────────────────────────────────────────────

export function parsePythonFile(
  absolutePath: string,
  relativeFilePath: string,
  repo: string
): ParsedFile {
  try {
    const sourceCode = readFileSync(absolutePath, 'utf8');

    const parser = new (Parser as unknown as new () => InstanceType<typeof Parser>)();
    (parser as unknown as { setLanguage(l: unknown): void }).setLanguage(Python);
    const tree = (parser as unknown as { parse(src: string): { rootNode: TSNode } }).parse(sourceCode);
    const root = tree.rootNode;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const fileId = nodeId(repo, relativeFilePath, '__file__');

    // ── 1. Functions and Classes ──────────────────────────────────────────────

    const fnQuery = new Query(Python, '(function_definition name: (identifier) @name)') as TSQuery;
    const classQuery = new Query(Python, '(class_definition name: (identifier) @name)') as TSQuery;

    const fnCaptures = fnQuery.captures(root);
    for (const cap of fnCaptures) {
      const nameNode = cap.node;
      const fnNode = nameNode.parent; // function_definition
      if (!fnNode) continue;

      const inClass = isInsideClass(fnNode);
      const kind: NodeKind = inClass ? 'method' : 'function';
      const name = nameNode.text;

      // Check if this function is inside a decorated_definition for route detection
      const decorated = fnNode.parent?.type === 'decorated_definition' ? fnNode.parent : null;
      let routeInfo: RouteInfo | null = null;

      if (decorated) {
        for (const child of decorated.children) {
          if (child.type === 'decorator') {
            routeInfo = parseRouteDecorator(child);
            if (routeInfo) break;
          }
        }
      }

      const effectiveKind: NodeKind = routeInfo ? 'route' : kind;

      const n: GraphNode = {
        id: nodeId(repo, relativeFilePath, name),
        kind: effectiveKind,
        name,
        file: relativeFilePath,
        repo,
        startLine: (decorated ?? fnNode).startPosition.row + 1,
        endLine: (decorated ?? fnNode).endPosition.row + 1,
      };

      if (routeInfo) {
        n.meta = {
          httpMethod: routeInfo.httpMethod,
          httpPath: routeInfo.httpPath,
          decorator: routeInfo.decorator,
        };
      }

      nodes.push(n);
    }

    const classCaptures = classQuery.captures(root);
    for (const cap of classCaptures) {
      const nameNode = cap.node;
      const classNode = nameNode.parent;
      if (!classNode) continue;

      const name = nameNode.text;
      nodes.push({
        id: nodeId(repo, relativeFilePath, name),
        kind: 'class',
        name,
        file: relativeFilePath,
        repo,
        startLine: classNode.startPosition.row + 1,
        endLine: classNode.endPosition.row + 1,
      });
    }

    // ── 2. LangGraph: first pass — find StateGraph assignments ────────────────

    // Map from variable name → agent GraphNode (index into nodes)
    const agentByVar = new Map<string, GraphNode>();

    function walkForAgents(node: TSNode): void {
      const result = parseStateGraphAssignment(node);
      if (result) {
        const { varName, agentType } = result;
        const agentNode: GraphNode = {
          id: nodeId(repo, relativeFilePath, varName),
          kind: 'agent',
          name: varName,
          file: relativeFilePath,
          repo,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          meta: {
            agentType,
            agentNodes: [],
            agentEdges: [],
          },
        };
        nodes.push(agentNode);
        agentByVar.set(varName, agentNode);
      }
      for (const child of node.children) {
        walkForAgents(child);
      }
    }
    walkForAgents(root);

    // ── 3. LangGraph: second pass — add_node and add_edge ────────────────────

    function walkForLangGraphCalls(node: TSNode): void {
      const addNodeResult = parseAddNode(node);
      if (addNodeResult) {
        const agent = agentByVar.get(addNodeResult.object);
        if (agent?.meta) {
          agent.meta.agentNodes = agent.meta.agentNodes ?? [];
          agent.meta.agentNodes.push(addNodeResult.nodeName);
        }
      }

      const addEdgeResult = parseAddEdge(node);
      if (addEdgeResult) {
        const agent = agentByVar.get(addEdgeResult.object);
        if (agent?.meta) {
          agent.meta.agentEdges = agent.meta.agentEdges ?? [];
          agent.meta.agentEdges.push({
            from: addEdgeResult.from,
            to: addEdgeResult.to,
            conditional: addEdgeResult.conditional,
          });

          // Also emit a GraphEdge
          edges.push({
            from: agent.id,
            to: nodeId(repo, relativeFilePath, addEdgeResult.to),
            kind: 'agent_edge',
            crossRepo: false,
          });
        }
      }

      for (const child of node.children) {
        walkForLangGraphCalls(child);
      }
    }
    walkForLangGraphCalls(root);

    // ── 4. Imports ────────────────────────────────────────────────────────────

    // import_statement: `import foo.bar`
    const importQuery = new Query(Python, '(import_statement) @imp') as TSQuery;
    const importFromQuery = new Query(Python, '(import_from_statement) @imp') as TSQuery;

    for (const cap of importQuery.captures(root)) {
      const importNode = cap.node;
      // dotted_name children give us the module name
      const dottedName = importNode.children.find(c => c.type === 'dotted_name');
      if (dottedName) {
        edges.push({
          from: fileId,
          to: dottedName.text,
          kind: 'imports',
          crossRepo: false,
        });
      }
    }

    for (const cap of importFromQuery.captures(root)) {
      const importNode = cap.node;
      // module_name field gives dotted_name
      const moduleNameNode = importNode.childForFieldName('module_name');
      if (moduleNameNode) {
        edges.push({
          from: fileId,
          to: moduleNameNode.text,
          kind: 'imports',
          crossRepo: false,
        });
      }
    }

    return { nodes, edges };
  } catch (err) {
    console.error('[codegraph] Failed to parse', relativeFilePath, err);
    return { nodes: [], edges: [] };
  }
}
