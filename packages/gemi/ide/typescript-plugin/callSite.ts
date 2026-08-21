import type ts from "typescript";

import { getStringValue, type TS } from "./ast";
import type { HttpVerb } from "./types";

const HTTP_VERBS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Attributes that name a page to navigate to rather than an endpoint to call. */
const VIEW_ATTRIBUTES = new Set(["href", "to"]);
/** Attributes that name an endpoint to submit to. `<Form action=… method=…>`. */
const ACTION_ATTRIBUTES = new Set(["action"]);

export interface RouteQuery {
  node: ts.StringLiteralLike;
  /** The literal's text — the route path as the user typed it. */
  path: string;
  /**
   * The paths this position is allowed to hold, when the signature says so.
   *
   * `useQuery(url: T)` declares `T extends keyof GetRPC`, so the constraint of
   * the parameter this argument fills *is* the GET route set — which is how a
   * `useQuery` call is told apart from a `useMutation` one without either name
   * appearing here. Any wrapper an app writes over these hooks carries the same
   * constraint through, and is understood for free.
   */
  allowedPaths?: ReadonlySet<string>;
  /** A verb the call site names outright, e.g. `useMutation("PUT", …)`. */
  verb?: HttpVerb;
  /** Whether the surrounding syntax means a page or an endpoint. */
  prefer?: "api" | "view";
}

/**
 * Decides whether the string literal at `position` is naming a route, and
 * gathers whatever the surrounding code says about *which* route.
 *
 * Nothing here confirms the path exists — that is the route table's job. This
 * only answers "could this be a route reference, and what narrows it".
 */
export function findRouteQuery(
  ts: TS,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  position: number,
): RouteQuery | undefined {
  const node = findStringLiteral(ts, sourceFile, position);
  if (!node) return undefined;
  if (!isRouteReferencePosition(ts, node)) return undefined;

  return {
    node,
    path: node.text,
    allowedPaths: allowedPathsAt(ts, checker, node),
    ...contextHints(ts, checker, node),
  };
}

function findStringLiteral(
  ts: TS,
  sourceFile: ts.SourceFile,
  position: number,
): ts.StringLiteralLike | undefined {
  let found: ts.StringLiteralLike | undefined;
  const visit = (node: ts.Node): void => {
    if (position < node.getFullStart() || position > node.getEnd()) return;
    if (ts.isStringLiteralLike(node)) {
      // Inside the quotes only: at the closing quote the request belongs to
      // whatever follows, and hijacking it there would be surprising.
      const start = node.getStart(sourceFile);
      if (position > start && position < node.getEnd()) found = node;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Rejects the string positions that already mean something else, so the plugin
 * never shadows a definition TypeScript can answer better itself.
 */
function isRouteReferencePosition(ts: TS, node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // Module specifiers already go to definition — the module.
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return false;
  if (ts.isImportTypeNode(parent) || ts.isExternalModuleReference(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;

  // A key, not a value.
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }

  // A type, where the definition is the type declaration.
  if (ts.isLiteralTypeNode(parent)) return false;

  // `config["/home"]` — TypeScript resolves this to the property, and that is
  // the better answer.
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return false;

  return true;
}

function allowedPathsAt(
  ts: TS,
  checker: ts.TypeChecker,
  node: ts.StringLiteralLike,
): ReadonlySet<string> | undefined {
  const site = argumentSite(ts, node);
  if (!site) return undefined;

  const declaration = checker.getResolvedSignature(site.call)?.getDeclaration();
  if (!declaration || !ts.isFunctionLike(declaration)) return undefined;

  const parameter = declaration.parameters[site.index];
  // A rest parameter's elements are not this simple to index into, and no route
  // argument is declared that way.
  if (!parameter || parameter.dotDotDotToken) return undefined;

  // The *declared* type, not the contextual one: by the time inference has run,
  // the contextual type of `"/reports"` is `"/reports"`, which says nothing
  // about what else was allowed there.
  let type = checker.getTypeAtLocation(parameter);
  if (site.property !== undefined) {
    const symbol = type.getProperty(site.property);
    if (!symbol) return undefined;
    type = checker.getTypeOfSymbolAtLocation(symbol, parameter);
  }

  const constraint = checker.getBaseConstraintOfType(type) ?? type;
  return stringLiteralSet(constraint);
}

interface ArgumentSite {
  call: ts.CallExpression | ts.NewExpression;
  index: number;
  /** Set when the path is a property of an options object rather than the argument. */
  property?: string;
}

/**
 * The call an argument belongs to, and where in it.
 *
 * A path is usually an argument outright — `useQuery("/reports")` — but
 * `useMutate`'s is a property of an options object: `mutate({ path: "/reports" })`
 * (`client/useMutate.ts`). Both are declared the same way, `T extends keyof
 * GetRPC`, one on the parameter and one on a property of it, so both are located
 * here and read through the same constraint afterwards. Any other hook that
 * takes its path in an options object is covered by the same rule.
 */
function argumentSite(ts: TS, node: ts.StringLiteralLike): ArgumentSite | undefined {
  const parent = node.parent;
  if (!parent) return undefined;

  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const index = [...(parent.arguments ?? [])].indexOf(node);
    return index < 0 ? undefined : { call: parent, index };
  }

  if (!ts.isPropertyAssignment(parent) || parent.initializer !== node) return undefined;
  const property =
    ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name)
      ? parent.name.text
      : undefined;
  if (property === undefined) return undefined;

  const object = parent.parent;
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const call = object.parent;
  if (!call || (!ts.isCallExpression(call) && !ts.isNewExpression(call))) return undefined;
  const index = [...(call.arguments ?? [])].indexOf(object);
  return index < 0 ? undefined : { call, index, property };
}

/** The set a type denotes, or `undefined` if it is anything but string literals. */
function stringLiteralSet(type: ts.Type): ReadonlySet<string> | undefined {
  const members = type.isUnion() ? type.types : [type];
  const paths = new Set<string>();
  for (const member of members) {
    if (!member.isStringLiteral()) return undefined;
    paths.add(member.value);
  }
  return paths.size > 0 ? paths : undefined;
}

function contextHints(
  ts: TS,
  checker: ts.TypeChecker,
  node: ts.StringLiteralLike,
): { verb?: HttpVerb; prefer?: "api" | "view" } {
  const attribute = enclosingJsxAttribute(ts, node);
  if (attribute) {
    const name = ts.isIdentifier(attribute.name) ? attribute.name.text : attribute.name.getText();
    if (VIEW_ATTRIBUTES.has(name)) return { prefer: "view" };
    if (ACTION_ATTRIBUTES.has(name)) {
      return { prefer: "api", verb: siblingMethodVerb(ts, checker, attribute) ?? "POST" };
    }
    return {};
  }

  // `useMutation("PUT", "/products/:id")`: the verb sits in the argument
  // before the path. Keyed off the shape rather than the callee's name, so a
  // wrapper that forwards both arguments is understood too.
  const call = node.parent;
  if (call && ts.isCallExpression(call)) {
    const index = call.arguments.indexOf(node);
    const previous = index > 0 ? call.arguments[index - 1] : undefined;
    const value = getStringValue(ts, checker, previous)?.toUpperCase();
    if (value && HTTP_VERBS.has(value)) return { verb: value as HttpVerb, prefer: "api" };
  }

  return {};
}

function enclosingJsxAttribute(ts: TS, node: ts.StringLiteralLike): ts.JsxAttribute | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (ts.isJsxAttribute(parent)) return parent;
  if (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
    return parent.parent;
  }
  return undefined;
}

function siblingMethodVerb(
  ts: TS,
  checker: ts.TypeChecker,
  attribute: ts.JsxAttribute,
): HttpVerb | undefined {
  const attributes = attribute.parent;
  if (!attributes || !ts.isJsxAttributes(attributes)) return undefined;
  for (const sibling of attributes.properties) {
    if (!ts.isJsxAttribute(sibling)) continue;
    const name = ts.isIdentifier(sibling.name) ? sibling.name.text : sibling.name.getText();
    if (name !== "method" || !sibling.initializer) continue;
    const initializer = ts.isJsxExpression(sibling.initializer)
      ? sibling.initializer.expression
      : sibling.initializer;
    const value = getStringValue(ts, checker, initializer)?.toUpperCase();
    if (value && HTTP_VERBS.has(value)) return value as HttpVerb;
  }
  return undefined;
}
