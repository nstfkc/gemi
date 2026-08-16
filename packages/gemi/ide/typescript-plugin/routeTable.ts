import type ts from "typescript";

import {
  displayNameOfClass,
  getPropertyKeyText,
  getRoutesObjectLiteral,
  getStringValue,
  getThisCall,
  resolveClassDeclaration,
  spanOf,
  targetFromDeclaration,
  unwrapBuilderChain,
  unwrapExpression,
  type TS,
} from "./ast";
import { findRootRouters } from "./entryPoints";
import { joinHandlerMapKey, parsePrefixAndKey, removeTrailingId } from "./routePath";
import type { ApiRouteEntry, HttpVerb, RouteTable, RouteTarget, ViewRouteEntry } from "./types";

export interface BuildOptions {
  /** Directory the app's `app/` folder sits in. */
  projectRoot: string;
  /** Where `this.view("auth/SignIn")` looks for `auth/SignIn.tsx`. */
  viewsDir: string;
  fileExists: (fileName: string) => boolean;
}

const VERBS: Record<string, HttpVerb> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
};

/**
 * The five routes `this.resource(C)` expands to, and where each lands.
 *
 * `list` and `store` sit on the collection — the route key with its trailing
 * `:id` segment removed — and the other three on the member. That split is
 * `ResourceRoutes`' `first`/`second` in `http/ApiRouter.ts`.
 */
const RESOURCE_ROUTES: ReadonlyArray<{
  method: string;
  verb: HttpVerb;
  scope: "collection" | "member";
}> = [
  { method: "list", verb: "GET", scope: "collection" },
  { method: "store", verb: "POST", scope: "collection" },
  { method: "show", verb: "GET", scope: "member" },
  { method: "update", verb: "PUT", scope: "member" },
  { method: "delete", verb: "DELETE", scope: "member" },
];

const VIEW_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

/**
 * Walks an app's router tree and records, for every route the client can name,
 * where its handler is written.
 *
 * The walk mirrors `RouteParser`/`RoutesParser` rather than the runtime: those
 * conditional types are what turn a `routes` object into the string literals a
 * `useQuery` call site is constrained to, so matching them is what makes a
 * lookup by that literal possible. Everything the types reach, this reaches;
 * everything they drop (`file`, `stream`, `proxy`) is still indexed, marked
 * `inRpc: false`, because a hardcoded URL elsewhere in the app may still name it.
 */
export function buildRouteTable(ts: TS, program: ts.Program, options: BuildOptions): RouteTable {
  return new RouteTableBuilder(ts, program, options).build();
}

class RouteTableBuilder {
  private readonly checker: ts.TypeChecker;
  private readonly api = new Map<string, ApiRouteEntry[]>();
  private readonly views = new Map<string, ViewRouteEntry[]>();
  private readonly dependencies = new Set<string>();
  private readonly diagnostics: string[] = [];

  constructor(
    private readonly ts: TS,
    private readonly program: ts.Program,
    private readonly options: BuildOptions,
  ) {
    this.checker = program.getTypeChecker();
  }

  build(): RouteTable {
    const roots = findRootRouters(this.ts, this.program, this.options.projectRoot);
    for (const dependency of roots.dependencies) this.dependencies.add(dependency);
    this.diagnostics.push(...roots.diagnostics);

    for (const mount of roots.api) this.walkApiRouter(mount.declaration, mount.prefix, []);
    for (const mount of roots.view) this.walkViewRouter(mount.declaration, mount.prefix, []);

    return {
      api: this.api,
      views: this.views,
      dependencies: [...this.dependencies],
      diagnostics: this.diagnostics,
    };
  }

  // -- API routers ---------------------------------------------------------

  private walkApiRouter(
    classDeclaration: ts.ClassLikeDeclaration,
    prefix: string,
    stack: ts.ClassLikeDeclaration[],
  ): void {
    const ts = this.ts;
    const routes = getRoutesObjectLiteral(ts, classDeclaration);
    if (!routes) return;
    this.dependencies.add(classDeclaration.getSourceFile().fileName);

    for (const property of routes.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = getPropertyKeyText(ts, this.checker, property.name);
      if (key === undefined) continue;
      const value = unwrapExpression(ts, property.initializer);

      // A bare class reference mounts another router under this key.
      const nested = resolveClassDeclaration(ts, this.checker, value);
      if (nested && getRoutesObjectLiteral(ts, nested)) {
        // Guard the current chain, not every router seen: mounting the same
        // router at two prefixes is legitimate, mounting it inside itself is not.
        if (stack.includes(nested)) {
          this.diagnostics.push(
            `router cycle at ${parsePrefixAndKey(prefix, key)}; stopped descending`,
          );
          continue;
        }
        this.walkApiRouter(nested, parsePrefixAndKey(prefix, key), [...stack, nested]);
        continue;
      }

      // A verb map — `{ get: this.get(...), post: this.post(...) }` — puts
      // several verbs on one path. `RouteHandlersParser` concatenates its
      // prefix raw, so this key does not go through `parsePrefixAndKey`.
      if (ts.isObjectLiteralExpression(value)) {
        const path = joinHandlerMapKey(prefix, key);
        for (const inner of value.properties) {
          if (!ts.isPropertyAssignment(inner)) continue;
          this.addApiRoute(path, unwrapExpression(ts, inner.initializer), inner, classDeclaration);
        }
        continue;
      }

      this.addApiRoute(parsePrefixAndKey(prefix, key), value, property, classDeclaration);
    }
  }

  private addApiRoute(
    path: string,
    value: ts.Expression,
    entryNode: ts.PropertyAssignment,
    router: ts.ClassLikeDeclaration,
  ): void {
    const call = getThisCall(this.ts, unwrapBuilderChain(this.ts, value));
    if (!call) return;
    const fallback = this.routeEntryTarget(entryNode, router);

    if (call.method === "resource") {
      const controller = call.args[0];
      const collection = removeTrailingId(path);
      for (const { method, verb, scope } of RESOURCE_ROUTES) {
        const target = controller ? this.controllerMethodTarget(controller, method) : undefined;
        this.pushApi({
          path: scope === "collection" ? collection : path,
          verb,
          inRpc: true,
          targets: [target ?? fallback],
        });
      }
      return;
    }

    const verb = VERBS[call.method];
    if (verb) {
      this.pushApi({ path, verb, inRpc: true, targets: this.handlerTargets(call.args, fallback) });
      return;
    }

    // `file` and `stream` are GET routes that `CreateRPC` drops; `proxy`
    // forwards elsewhere and has no local handler to jump to.
    if (call.method === "file" || call.method === "stream") {
      this.pushApi({
        path,
        verb: "GET",
        inRpc: false,
        targets: this.handlerTargets(call.args, fallback),
      });
      return;
    }
    if (call.method === "proxy") {
      this.pushApi({ path, verb: "GET", inRpc: false, targets: [fallback] });
    }
  }

  private pushApi(entry: ApiRouteEntry): void {
    const existing = this.api.get(entry.path);
    if (existing) existing.push(entry);
    else this.api.set(entry.path, [entry]);
  }

  // -- View routers --------------------------------------------------------

  private walkViewRouter(
    classDeclaration: ts.ClassLikeDeclaration,
    prefix: string,
    stack: ts.ClassLikeDeclaration[],
  ): void {
    const routes = getRoutesObjectLiteral(this.ts, classDeclaration);
    if (!routes) return;
    this.dependencies.add(classDeclaration.getSourceFile().fileName);
    this.walkViewRoutes(routes, prefix, stack, classDeclaration);
  }

  private walkViewRoutes(
    routes: ts.ObjectLiteralExpression,
    prefix: string,
    stack: ts.ClassLikeDeclaration[],
    router: ts.ClassLikeDeclaration,
  ): void {
    const ts = this.ts;
    for (const property of routes.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = getPropertyKeyText(ts, this.checker, property.name);
      if (key === undefined) continue;
      const value = unwrapExpression(ts, property.initializer);
      const path = parsePrefixAndKey(prefix, key);

      const nested = resolveClassDeclaration(ts, this.checker, value);
      if (nested && getRoutesObjectLiteral(ts, nested)) {
        if (stack.includes(nested)) {
          this.diagnostics.push(`view router cycle at ${path}; stopped descending`);
          continue;
        }
        this.walkViewRouter(nested, path, [...stack, nested]);
        continue;
      }

      const call = getThisCall(ts, unwrapBuilderChain(ts, value));
      if (!call) continue;
      const fallback = this.routeEntryTarget(property, router);

      switch (call.method) {
        case "view":
          this.pushView({
            path,
            kind: "view",
            inRpc: true,
            targets: this.viewTargets(call.args[0], call.args[1], fallback),
          });
          break;

        case "redirect":
          this.pushView({
            path,
            kind: "view",
            inRpc: true,
            targets: this.viewTargets(undefined, call.args[0], fallback),
          });
          break;

        case "file":
          // `RoutesParser` maps `FileRoute` to `never`, so no typed call site
          // names this path — indexed for hardcoded URLs only.
          this.pushView({
            path,
            kind: "view",
            inRpc: false,
            targets: this.viewTargets(undefined, call.args[0], fallback),
          });
          break;

        case "layout": {
          // `layout(viewPath, handler, routes)` and `layout(viewPath, routes)`
          // are both legal; the children are whichever argument is an object.
          const second = call.args[1] ? unwrapExpression(ts, call.args[1]) : undefined;
          const third = call.args[2] ? unwrapExpression(ts, call.args[2]) : undefined;
          const children =
            third && ts.isObjectLiteralExpression(third)
              ? third
              : second && ts.isObjectLiteralExpression(second)
                ? second
                : undefined;
          const handler = children === second ? undefined : second;

          this.pushView({
            path,
            kind: "layout",
            inRpc: true,
            targets: this.viewTargets(call.args[0], handler, fallback),
          });
          if (children) this.walkViewRoutes(children, path, stack, router);
          break;
        }
      }
    }
  }

  private pushView(entry: ViewRouteEntry): void {
    const existing = this.views.get(entry.path);
    if (existing) existing.push(entry);
    else this.views.set(entry.path, [entry]);
  }

  /**
   * A view route has up to two places worth going: the component it renders and
   * the controller method that feeds it. Both are offered, component first —
   * editors show a picker when a definition resolves to more than one place.
   */
  private viewTargets(
    viewPath: ts.Expression | undefined,
    handler: ts.Expression | undefined,
    fallback: RouteTarget,
  ): RouteTarget[] {
    const targets: RouteTarget[] = [];
    const component = viewPath ? this.viewComponentTarget(viewPath) : undefined;
    if (component) targets.push(component);
    if (handler) targets.push(...this.handlerTargets([handler], fallback, { silent: true }));
    return targets.length > 0 ? targets : [fallback];
  }

  private viewComponentTarget(viewPath: ts.Expression): RouteTarget | undefined {
    const ts = this.ts;
    const relative = getStringValue(ts, this.checker, viewPath);
    if (!relative) return undefined;

    for (const extension of VIEW_EXTENSIONS) {
      const fileName = `${this.options.viewsDir}/${relative}${extension}`;
      const sourceFile = this.program.getSourceFile(fileName);
      if (sourceFile) {
        this.dependencies.add(fileName);
        const exported = this.defaultExportDeclaration(sourceFile);
        if (exported) {
          return targetFromDeclaration(ts, exported, relative, "view", "view-component");
        }
        return {
          fileName,
          span: { start: 0, length: 0 },
          name: relative,
          containerName: "view",
          kind: "view-component",
        };
      }
      // A view nothing imports is absent from the program even though it is on
      // disk — the whole point of the views directory is that the framework
      // loads it, not the app. Jumping to the file still works.
      if (this.options.fileExists(fileName)) {
        return {
          fileName,
          span: { start: 0, length: 0 },
          name: relative,
          containerName: "view",
          kind: "view-component",
        };
      }
    }
    return undefined;
  }

  private defaultExportDeclaration(sourceFile: ts.SourceFile): ts.Declaration | undefined {
    const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return undefined;
    for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
      if (exported.name !== "default") continue;
      const resolved =
        exported.flags & this.ts.SymbolFlags.Alias
          ? this.checker.getAliasedSymbol(exported)
          : exported;
      const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
      if (declaration) return declaration;
    }
    return undefined;
  }

  // -- Handlers ------------------------------------------------------------

  /**
   * Where a route's arguments say its work happens.
   *
   * `(Controller, "method")` and `[Controller, "method"]` — the API and view
   * spellings of the same thing — resolve to the method. An inline callback
   * resolves to itself. Anything else falls back to the `routes` entry, so a
   * shape this does not understand degrades to a jump into the router rather
   * than to no jump at all.
   */
  private handlerTargets(
    args: readonly ts.Expression[],
    fallback: RouteTarget,
    options: { silent?: boolean } = {},
  ): RouteTarget[] {
    const ts = this.ts;
    const first = args[0] ? unwrapExpression(ts, args[0]) : undefined;
    if (!first) return options.silent ? [] : [fallback];

    if (ts.isArrayLiteralExpression(first)) {
      const [controller, method] = first.elements;
      const name = getStringValue(ts, this.checker, method);
      const target = controller && name ? this.controllerMethodTarget(controller, name) : undefined;
      return [target ?? fallback];
    }

    if (ts.isFunctionExpression(first) || ts.isArrowFunction(first)) {
      return [
        {
          fileName: first.getSourceFile().fileName,
          span: spanOf(first),
          contextSpan: spanOf(first),
          name: "handler",
          containerName: "",
          kind: "inline-handler",
        },
      ];
    }

    const methodName = getStringValue(ts, this.checker, args[1]);
    if (methodName) {
      const target = this.controllerMethodTarget(first, methodName);
      if (target) return [target];
    }

    return options.silent ? [] : [fallback];
  }

  /**
   * The declaration of `methodName` on the class an expression names.
   *
   * Resolved through the instance type rather than the class body, so a method
   * inherited from a base controller — or reached through an import alias, or a
   * re-export — is found the same way the compiler finds it.
   */
  private controllerMethodTarget(
    controller: ts.Expression,
    methodName: string,
  ): RouteTarget | undefined {
    const type = this.checker.getTypeAtLocation(controller);
    const instance = type.getConstructSignatures()[0]?.getReturnType();
    const property = instance?.getProperty(methodName);
    const declaration = property?.declarations?.[0];
    if (!declaration) return undefined;

    this.dependencies.add(declaration.getSourceFile().fileName);
    return targetFromDeclaration(
      this.ts,
      declaration,
      methodName,
      displayNameOfClass(this.ts, this.checker, controller),
      "controller-method",
    );
  }

  private routeEntryTarget(
    property: ts.PropertyAssignment,
    router: ts.ClassLikeDeclaration,
  ): RouteTarget {
    return {
      fileName: property.getSourceFile().fileName,
      span: spanOf(property.name),
      contextSpan: spanOf(property),
      name: getPropertyKeyText(this.ts, this.checker, property.name) ?? "route",
      containerName: router.name?.text ?? "router",
      kind: "route-entry",
    };
  }
}
