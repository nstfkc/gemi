import type ts from "typescript";

import type { Span, TargetKind } from "./types";

/**
 * The `typescript` module, as tsserver hands it to a plugin.
 *
 * A language service plugin must never `require("typescript")` itself — the
 * editor may be running a different copy than the one resolvable from the
 * plugin's own `node_modules`, and two copies means enums with different
 * numeric values and `instanceof`-style identity checks that quietly fail. Every
 * function here takes the injected module instead.
 */
export type TS = typeof ts;

/** Strips the wrappers that carry no meaning for what an expression *is*. */
export function unwrapExpression(ts: TS, node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else return current;
  }
}

/**
 * Peels the fluent builders a route entry can be wrapped in —
 * `this.get(...).middleware([...])`, `this.layout(...).alwaysRun()` — down to
 * the `this.<method>(...)` call that decides what the route is.
 */
export function unwrapBuilderChain(ts: TS, node: ts.Expression): ts.Expression {
  const chainable = new Set(["middleware", "alwaysRun"]);
  let current = unwrapExpression(ts, node);
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    chainable.has(current.expression.name.text)
  ) {
    current = unwrapExpression(ts, current.expression.expression);
  }
  return current;
}

export interface ThisCall {
  method: string;
  args: readonly ts.Expression[];
  node: ts.CallExpression;
}

/** Matches `this.<method>(...)`, the shape every route builder takes. */
export function getThisCall(ts: TS, node: ts.Expression): ThisCall | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  return { method: callee.name.text, args: node.arguments, node };
}

/**
 * The string an expression denotes, whether it is spelled inline or reached
 * through a constant. The checker answers the second case for free, so
 * `this.get(Controller, METHOD)` resolves as well as `this.get(Controller, "x")`.
 */
export function getStringValue(
  ts: TS,
  checker: ts.TypeChecker,
  node: ts.Expression | undefined,
): string | undefined {
  if (!node) return undefined;
  const expression = unwrapExpression(ts, node);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  const type = checker.getTypeAtLocation(expression);
  if (type.isStringLiteral()) return type.value;
  return undefined;
}

/** The key of a `routes` entry, including `[SOME_CONST]: ...` computed keys. */
export function getPropertyKeyText(
  ts: TS,
  checker: ts.TypeChecker,
  name: ts.PropertyName,
): string | undefined {
  if (ts.isStringLiteralLike(name)) return name.text;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return getStringValue(ts, checker, name.expression);
  return undefined;
}

/** Follows imports and aliases to the class an expression names. */
export function resolveClassDeclaration(
  ts: TS,
  checker: ts.TypeChecker,
  node: ts.Expression,
): ts.ClassLikeDeclaration | undefined {
  if (ts.isClassExpression(node)) return node;
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration && ts.isClassLike(declaration) ? declaration : undefined;
}

/**
 * The object literal assigned to a class's `routes` property.
 *
 * A router that assigns `routes` anywhere but its own initializer — in a
 * constructor, behind a helper — is invisible here, and that is a deliberate
 * floor rather than a gap to close: those shapes are invisible to `CreateRPC`
 * too, so a route declared that way has no typed call site to jump from.
 *
 * A spread *inside* the initializer is the one case where the two disagree.
 * `RouteParser` reads the declared type of `routes` and so keeps it; the walk
 * reads syntax and drops it. `RouteTableBuilder.noteUnreadableEntry` logs each
 * one it meets, because a route that autocompletes and does not jump is
 * otherwise indistinguishable from a bug in this plugin.
 */
export function getRoutesObjectLiteral(
  ts: TS,
  classDeclaration: ts.ClassLikeDeclaration,
): ts.ObjectLiteralExpression | undefined {
  for (const member of classDeclaration.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    if (!member.name || !ts.isIdentifier(member.name) || member.name.text !== "routes") continue;
    if (!member.initializer) continue;
    const initializer = unwrapExpression(ts, member.initializer);
    if (ts.isObjectLiteralExpression(initializer)) return initializer;
  }
  return undefined;
}

export function spanOf(node: ts.Node): Span {
  const start = node.getStart(node.getSourceFile());
  return { start, length: node.getEnd() - start };
}

/** The identifier a declaration is named by, which is where a jump should land. */
export function nameNodeOf(ts: TS, declaration: ts.Declaration): ts.Node {
  const named = declaration as ts.NamedDeclaration;
  return named.name && !ts.isComputedPropertyName(named.name) ? named.name : declaration;
}

export function targetFromDeclaration(
  ts: TS,
  declaration: ts.Declaration,
  name: string,
  containerName: string,
  kind: TargetKind,
): {
  fileName: string;
  span: Span;
  contextSpan: Span;
  name: string;
  containerName: string;
  kind: TargetKind;
} {
  return {
    fileName: declaration.getSourceFile().fileName,
    span: spanOf(nameNodeOf(ts, declaration)),
    contextSpan: spanOf(declaration),
    name,
    containerName,
    kind,
  };
}

/** The class name to show alongside a handler, skipping `export default class`'s `"default"`. */
export function displayNameOfClass(
  ts: TS,
  checker: ts.TypeChecker,
  expression: ts.Expression,
): string {
  const declaration = resolveClassDeclaration(ts, checker, expression);
  if (declaration?.name) return declaration.name.text;
  return expression.getText();
}
