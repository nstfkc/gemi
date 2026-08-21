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
  api: { interfaceName: "RPC" },
  view: { interfaceName: "ViewRPC" },
} as const;

const CONFIG_HELPER = "defineRouteConfig";
const CONFIG_MODULE = "gemi/services";
/** The module `RPC` and `ViewRPC` are declared in and augmented into. */
const CLIENT_MODULE = "gemi/client";

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
 * The route config and then convention are the fallbacks, for a project whose
 * routers the augmentation does not name. They are chosen on whether the app's
 * *own* routers were found, not on whether anything was: `client/rpc.ts` mounts
 * `/auth/*` unconditionally, so "some mount exists" is true of every gemi
 * project and would make total discovery failure silent.
 */
export function findRootRouters(ts: TS, program: ts.Program, projectRoot: string): RootRouters {
  const checker = program.getTypeChecker();
  const result: RootRouters = { api: [], view: [], dependencies: [], diagnostics: [] };
  // One router can be reached through more than one declaration in the merge
  // group — the package's own augmentation and an app's leftover `gemi.d.ts`
  // name the same `Api`. Walking it twice would double every route it holds.
  const seen = new Set<string>();

  for (const kind of ["api", "view"] as const) {
    const { interfaceName } = RPC_INTERFACES[kind];
    for (const declaration of findInterfaceDeclarations(ts, checker, program, interfaceName)) {
      result.dependencies.push(declaration.getSourceFile().fileName);
      for (const mount of readMounts(ts, checker, declaration)) {
        const fileName = mount.declaration.getSourceFile().fileName;
        const key = `${kind}\0${mount.prefix}\0${fileName}\0${mount.declaration.pos}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result[kind].push(mount);
        result.dependencies.push(fileName);
      }
    }
  }

  const hasAppMount = (kind: "api" | "view") =>
    result[kind].some((mount) =>
      isApplicationFile(mount.declaration.getSourceFile().fileName, projectRoot),
    );

  if (hasAppMount("api") || hasAppMount("view")) return result;

  result.diagnostics.push(
    "the RPC / ViewRPC augmentation names none of this project's routers — falling back " +
      "to the app's route config. Check that gemi/client is imported and that " +
      `${projectRoot}/${FALLBACK_API_ROUTER}.ts typechecks, so route types and route jumps agree.`,
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

  if (!hasAppMount("api")) {
    const declaration = findConventionalRouter(ts, program, projectRoot, FALLBACK_API_ROUTER);
    if (declaration) {
      result.api.push({ declaration, prefix: "" });
      result.dependencies.push(declaration.getSourceFile().fileName);
    }
  }
  if (!hasAppMount("view")) {
    const declaration = findConventionalRouter(ts, program, projectRoot, FALLBACK_VIEW_ROUTER);
    if (declaration) {
      result.view.push({ declaration, prefix: "" });
      result.dependencies.push(declaration.getSourceFile().fileName);
    }
  }

  if (!hasAppMount("api") && !hasAppMount("view")) {
    result.diagnostics.push(
      `no application routers found: no ${CONFIG_HELPER}() call and nothing at ${projectRoot}/${FALLBACK_API_ROUTER}`,
    );
  }
  return result;
}

/** Whether a file belongs to the application rather than to a package it installs. */
function isApplicationFile(fileName: string, projectRoot: string): boolean {
  return fileName.startsWith(`${projectRoot}/`) && !fileName.includes("/node_modules/");
}

/**
 * Every declaration of an interface by this name, merged ones included.
 *
 * The interfaces are asked for through the `gemi/client` module symbol rather
 * than found by walking files, because since 0.56 the augmentation ships inside
 * the package: in an installed app the only file declaring `RPC` is
 * `node_modules/gemi/dist/gemi.d.ts`, which a file walk that skips
 * `node_modules` — as it must, to stay cheap — will never see. The module symbol
 * has no such blind spot. Reaching it costs one scan of the top-level statements
 * of the app's own files, looking for an `import … from "gemi/client"` or a
 * `declare module "gemi/client"`; from there the checker supplies the whole
 * merge group, package and application declarations alike.
 */
function findInterfaceDeclarations(
  ts: TS,
  checker: ts.TypeChecker,
  program: ts.Program,
  name: string,
): ts.InterfaceDeclaration[] {
  const fromModule = findClientModuleSymbol(ts, checker, program);
  if (fromModule) {
    const exported = checker.getExportsOfModule(fromModule).find((symbol) => symbol.name === name);
    const resolved =
      exported && exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
    const declarations = resolved?.declarations?.filter((declaration) =>
      ts.isInterfaceDeclaration(declaration),
    );
    if (declarations && declarations.length > 0) return declarations;
  }

  // No file names `gemi/client` — a project that has not imported it yet. Fall
  // back to finding one declaration by hand and letting the checker merge.
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

/** The symbol for the `gemi/client` module, reached through any reference to it. */
function findClientModuleSymbol(
  ts: TS,
  checker: ts.TypeChecker,
  program: ts.Program,
): ts.Symbol | undefined {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes("/node_modules/")) continue;

    for (const statement of sourceFile.statements) {
      const reference = clientModuleReference(ts, statement);
      if (!reference) continue;
      const symbol = checker.getSymbolAtLocation(reference);
      if (symbol) return symbol;
    }
  }
  return undefined;
}

/** The node naming `gemi/client` in a statement, if the statement names it. */
function clientModuleReference(ts: TS, statement: ts.Statement): ts.Node | undefined {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    const specifier = statement.moduleSpecifier;
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text === CLIENT_MODULE) {
      return specifier;
    }
    return undefined;
  }
  if (
    ts.isModuleDeclaration(statement) &&
    ts.isStringLiteralLike(statement.name) &&
    statement.name.text === CLIENT_MODULE
  ) {
    return statement.name;
  }
  return undefined;
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

/**
 * Reads `extends CreateRPC<Router, "/prefix">` off an interface declaration.
 *
 * The helper's name is deliberately not read. `CreateRPC` is only the direct
 * spelling; the package's own augmentation goes through an alias —
 * `extends AppRPC<Api>`, where `AppRPC` guards an unresolved `@/app/*` before it
 * can instantiate `CreateRPC` and blow the instantiation depth. Matching the
 * name `CreateRPC` rejected that, which since 0.56 is every application's own
 * routers. So the type arguments are what is read: whichever resolves to a class
 * is the router, and a string literal beside it is its prefix. Any wrapper —
 * the package's, or one an application writes — is understood the same way.
 */
function readMounts(
  ts: TS,
  checker: ts.TypeChecker,
  declaration: ts.InterfaceDeclaration,
): RouterMount[] {
  const mounts: RouterMount[] = [];
  for (const clause of declaration.heritageClauses ?? []) {
    for (const type of clause.types) {
      let router: ts.ClassLikeDeclaration | undefined;
      let prefix = "";
      for (const argument of type.typeArguments ?? []) {
        if (!router) {
          const resolved = resolveClassFromTypeNode(ts, checker, argument);
          if (resolved) {
            router = resolved;
            continue;
          }
        }
        if (!prefix) prefix = readPrefix(ts, checker, argument);
      }
      if (router) mounts.push({ declaration: router, prefix });
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
