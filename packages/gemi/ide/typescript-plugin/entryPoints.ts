import type ts from "typescript";

import { resolveClassDeclaration, unwrapExpression, type TS } from "./ast";

/** A router class and the path prefix it is mounted under. */
export interface RouterMount {
  declaration: ts.ClassLikeDeclaration;
  prefix: string;
}

export interface RootRouters {
  api: RouterMount[];
  view: RouterMount[];
  /** Files consulted to get here — part of the table's cache key. */
  dependencies: string[];
  diagnostics: string[];
}

const RPC_INTERFACES = {
  api: { interfaceName: "RPC", helperName: "CreateRPC" },
  view: { interfaceName: "ViewRPC", helperName: "CreateViewRPC" },
} as const;

const CONFIG_HELPER = "defineRouteConfig";
const CONFIG_MODULE = "gemi/services";

/** Conventional locations, tried only when nothing more authoritative is readable. */
const FALLBACK_API_ROUTER = "app/http/routes/api";
const FALLBACK_VIEW_ROUTER = "app/http/routes/view";

/**
 * Finds every router whose routes a client call site can name, and the prefix
 * each is mounted under.
 *
 * The authority is the `RPC` and `ViewRPC` interfaces, because they are what
 * the call site is typed against. An app declares its own routers by augmenting
 * them:
 *
 * ```ts
 * declare module "gemi/client" {
 *   export interface RPC extends CreateRPC<Api> {}
 * }
 * ```
 *
 * and the framework's base declaration in `client/rpc.ts` adds its own —
 * `CreateRPC<AuthApiRouter, "/auth">`. Reading the interfaces therefore picks up
 * both, with the right prefixes, and picks up exactly the routes `useQuery`
 * will accept. Reading the app's route config instead would find the app's
 * routers and miss `/auth/me`, which is as jumpable as any other route.
 *
 * The route config and then convention are the fallbacks, for a project that has
 * routers but no `gemi.d.ts` yet.
 */
export function findRootRouters(ts: TS, program: ts.Program, projectRoot: string): RootRouters {
  const checker = program.getTypeChecker();
  const result: RootRouters = { api: [], view: [], dependencies: [], diagnostics: [] };

  for (const kind of ["api", "view"] as const) {
    const { interfaceName, helperName } = RPC_INTERFACES[kind];
    for (const declaration of findInterfaceDeclarations(ts, checker, program, interfaceName)) {
      result.dependencies.push(declaration.getSourceFile().fileName);
      for (const mount of readMounts(ts, checker, declaration, helperName)) {
        result[kind].push(mount);
        result.dependencies.push(mount.declaration.getSourceFile().fileName);
      }
    }
  }

  if (result.api.length > 0 || result.view.length > 0) return result;

  result.diagnostics.push(
    "no RPC / ViewRPC augmentation found — falling back to the app's route config. " +
      "Add one to gemi.d.ts so route types and route jumps agree.",
  );

  const config = findRouteConfigCall(ts, program);
  if (config) {
    result.dependencies.push(config.getSourceFile().fileName);
    const object = unwrapExpression(ts, config.arguments[0] ?? config);
    if (ts.isObjectLiteralExpression(object)) {
      for (const kind of ["api", "view"] as const) {
        const declaration = readRootRouter(ts, checker, object, kind);
        if (!declaration) continue;
        result[kind].push({ declaration, prefix: "" });
        result.dependencies.push(declaration.getSourceFile().fileName);
      }
    }
  }

  if (result.api.length === 0) {
    const declaration = findConventionalRouter(ts, program, projectRoot, FALLBACK_API_ROUTER);
    if (declaration) {
      result.api.push({ declaration, prefix: "" });
      result.dependencies.push(declaration.getSourceFile().fileName);
    }
  }
  if (result.view.length === 0) {
    const declaration = findConventionalRouter(ts, program, projectRoot, FALLBACK_VIEW_ROUTER);
    if (declaration) {
      result.view.push({ declaration, prefix: "" });
      result.dependencies.push(declaration.getSourceFile().fileName);
    }
  }

  if (result.api.length === 0 && result.view.length === 0) {
    result.diagnostics.push(
      `no routers found: no ${CONFIG_HELPER}() call and nothing at ${projectRoot}/${FALLBACK_API_ROUTER}`,
    );
  }
  return result;
}

/**
 * Every declaration of an interface by this name, merged ones included.
 *
 * Only the app's own files are searched, which is enough to find one
 * declaration — the augmentation. From there the checker supplies the rest of
 * the merge group, including the framework's declaration inside `node_modules`,
 * without walking a single file in it.
 */
function findInterfaceDeclarations(
  ts: TS,
  checker: ts.TypeChecker,
  program: ts.Program,
  name: string,
): ts.InterfaceDeclaration[] {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes("/node_modules/")) continue;

    const local = findInterfaceIn(ts, sourceFile, name);
    if (!local) continue;

    const symbol = checker.getSymbolAtLocation(local.name);
    const declarations = symbol?.declarations?.filter((declaration) =>
      ts.isInterfaceDeclaration(declaration),
    );
    return declarations && declarations.length > 0 ? declarations : [local];
  }
  return [];
}

function findInterfaceIn(
  ts: TS,
  sourceFile: ts.SourceFile,
  name: string,
): ts.InterfaceDeclaration | undefined {
  let found: ts.InterfaceDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      found = node;
      return;
    }
    // Interfaces live at the top level or inside `declare module "…" { … }`;
    // nothing deeper needs visiting.
    if (ts.isSourceFile(node) || ts.isModuleDeclaration(node) || ts.isModuleBlock(node)) {
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  return found;
}

/** Reads `extends CreateRPC<Router, "/prefix">` off an interface declaration. */
function readMounts(
  ts: TS,
  checker: ts.TypeChecker,
  declaration: ts.InterfaceDeclaration,
  helperName: string,
): RouterMount[] {
  const mounts: RouterMount[] = [];
  for (const clause of declaration.heritageClauses ?? []) {
    for (const type of clause.types) {
      if (!ts.isIdentifier(type.expression) || type.expression.text !== helperName) continue;
      const [routerArgument, prefixArgument] = type.typeArguments ?? [];
      if (!routerArgument) continue;

      const router = resolveClassFromTypeNode(ts, checker, routerArgument);
      if (!router) continue;

      mounts.push({ declaration: router, prefix: readPrefix(ts, checker, prefixArgument) });
    }
  }
  return mounts;
}

function resolveClassFromTypeNode(
  ts: TS,
  checker: ts.TypeChecker,
  node: ts.TypeNode,
): ts.ClassLikeDeclaration | undefined {
  if (!ts.isTypeReferenceNode(node)) return undefined;
  const name = ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
  return resolveClassDeclaration(ts, checker, name as unknown as ts.Expression);
}

function readPrefix(ts: TS, checker: ts.TypeChecker, node: ts.TypeNode | undefined): string {
  if (!node) return "";
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal.text;
  const type = checker.getTypeFromTypeNode(node);
  return type.isStringLiteral() ? type.value : "";
}

function findRouteConfigCall(ts: TS, program: ts.Program): ts.CallExpression | undefined {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes("/node_modules/")) continue;

    // Cheap gate: only files that import the helper get walked. Import
    // statements are always at the top, so this scans a handful of nodes per
    // file rather than every node in the project.
    const localName = importedNameOf(ts, sourceFile);
    if (!localName) continue;

    let found: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === localName
      ) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    if (found) return found;
  }
  return undefined;
}

/** The local name `defineRouteConfig` is imported under, if this file imports it. */
function importedNameOf(ts: TS, sourceFile: ts.SourceFile): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteralLike(specifier) || specifier.text !== CONFIG_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === CONFIG_HELPER) return element.name.text;
    }
  }
  return undefined;
}

function readRootRouter(
  ts: TS,
  checker: ts.TypeChecker,
  config: ts.ObjectLiteralExpression,
  section: "api" | "view",
): ts.ClassLikeDeclaration | undefined {
  const sectionValue = getPropertyValue(ts, config, section);
  if (!sectionValue || !ts.isObjectLiteralExpression(sectionValue)) return undefined;
  const rootRouter = getPropertyValue(ts, sectionValue, "rootRouter");
  return rootRouter ? resolveClassDeclaration(ts, checker, rootRouter) : undefined;
}

function getPropertyValue(
  ts: TS,
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const key = property.name;
      const text = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (text === name) return unwrapExpression(ts, property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return undefined;
}

function findConventionalRouter(
  ts: TS,
  program: ts.Program,
  projectRoot: string,
  relativePath: string,
): ts.ClassLikeDeclaration | undefined {
  const checker = program.getTypeChecker();
  for (const extension of [".ts", ".tsx"]) {
    const sourceFile = program.getSourceFile(`${projectRoot}/${relativePath}${extension}`);
    if (!sourceFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      if (exported.name !== "default") continue;
      const resolved =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
      if (declaration && ts.isClassLike(declaration)) return declaration;
    }
  }
  return undefined;
}
