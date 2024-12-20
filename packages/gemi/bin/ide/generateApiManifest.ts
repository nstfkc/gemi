import { parse } from "recast";
import { join } from "path";
import { existsSync } from "fs";
import { toCamelCase } from "../../utils/toCamelCase";
import { generateGitDiffId } from "./generateGitDiffId";

const ROOT = process.cwd();

type Position = {
  file: string;
  line: number;
  column: number;
};

export class ApiManifestGenerator {
  cache: Map<string, Map<string, Position>> = new Map(); // Controller -> Method -> { file, line, column }

  // Store routes with their http methods and assign the router position to fallback when
  // the handler is a callback handler e.g `this.get(() => {})` instead of `this.get(Controller, "method")`
  routes: Map<
    string,
    Map<
      string,
      {
        controllerName: string | null;
        methodName: string | null;
        routerPosition: Position;
      }
    >
  > = new Map();
  rootRouterBody: any;

  routerBodyCache: Map<string, any> = new Map();
  controllerCache: Map<string, any> = new Map();
  private manifestCacheDir = join(ROOT, ".gemi/cache/api-routes-manifest");

  private async writeManifest(cacheFilePath: string) {
    const manifest: Record<
      string,
      Record<string, { file: string; line: number; column: number }>
    > = {};
    for (const [routeName, method] of this.routes.entries()) {
      for (const [
        httpMethod,
        { controllerName, methodName, routerPosition },
      ] of method.entries()) {
        if (!manifest[routeName]) {
          manifest[routeName] = {};
        }
        let result: Position | null = null;
        if (controllerName !== null && methodName !== null) {
          result = this.cache.get(controllerName)?.get(methodName) ?? null;
        }
        manifest[routeName][httpMethod] = result ?? routerPosition;
      }
    }
    const output = JSON.stringify(manifest, null, 2);
    console.log(output);
    Bun.write(cacheFilePath, output);
  }

  private async parseFile(filePath: string) {
    const content = await Bun.file(filePath).text();
    return await parse(content, {
      parser: await import("recast/parsers/typescript"),
    });
  }

  private normalizeImportPath(path: string, parentPath = "") {
    if (path.startsWith("@/app")) {
      return path.replace("@", "") + ".ts";
    }
    return join(parentPath, path) + ".ts";
  }

  private isFileShouldBeParsed(path: string) {
    return (
      path.includes("app/http/router") || path.includes("app/http/controllers")
    );
  }

  private isNodeShouldBeParsed(node: any) {
    const superClass =
      node?.declaration?.superClass?.name ?? node?.superClass?.name;
    return (
      ["ApiRouter", "Controller", "ResourceController"].includes(superClass) ||
      node.type === "ImportDeclaration"
    );
  }

  private async parseControllerBody(
    body: any,
    name: string,
    controllerFilePath: string,
  ) {
    for (const node of body) {
      if (node.type === "ClassMethod") {
        if (!this.cache.has(name)) {
          this.cache.set(name, new Map());
        }
        this.cache.get(name)?.set(node.key.name, {
          file: controllerFilePath,
          line: node.loc.start.line,
          column: node.loc.start.column,
        });
      }
    }
  }

  private isControllerNode(node: any) {
    return (
      node?.declaration?.superClass?.name === "Controller" ||
      node?.declaration?.superClass?.name === "ResourceController"
    );
  }
  private isRouterNode(body: any) {
    return (
      body?.declaration?.superClass.name === "ApiRouter" ||
      body?.superClass?.name === "ApiRouter"
    );
  }

  private async parseControllerFile(
    file: any,
    name: string,
    controllerFilePath: string,
  ) {
    for (const node of file.program.body) {
      if (this.isControllerNode(node)) {
        this.parseControllerBody(
          node.declaration.body.body,
          name,
          controllerFilePath,
        );
      }
    }
  }

  private isLibraryImport(node: any) {
    // TODO: check package.json for dependencies
    return (
      !node.source.value.startsWith(".") && !node.source.value.startsWith("@")
    );
  }

  private async parseImportDeclaration(node: any, parentPath = "") {
    if (this.isLibraryImport(node)) return;
    const normalizedPath = this.normalizeImportPath(
      node.source.value,
      parentPath
        .split("/")
        .filter((item) => !item.includes(".ts"))
        .join("/"),
    );
    if (!this.isFileShouldBeParsed(normalizedPath)) return;
    if (normalizedPath.startsWith("/app/http/controllers")) {
      for (const specifier of node.specifiers) {
        const name =
          specifier.type === "ImportDefaultSpecifier"
            ? specifier.local.name
            : specifier.imported.name;

        await this.parseControllerFile(
          await this.parseFile(join(ROOT, normalizedPath)),
          name,
          normalizedPath,
        );
      }
    }
    if (normalizedPath.startsWith("/app/http/router")) {
      for (const specifier of node.specifiers) {
        const name =
          specifier.type === "ImportDefaultSpecifier"
            ? specifier.local.name
            : specifier.imported.name;
        await this.parse("", normalizedPath, false, name);
      }
    }
  }

  private async parseRoute(
    property: any,
    routePath: string,
    parentFilePath: string,
    parentRoutePath = "",
  ) {
    const method = property.value?.callee?.original.property.name;

    const line = property.loc.start.line;
    const column = property.loc.start.column;
    let controllerName: string | null = null;
    let methodName: string | null = null;

    const finalRoutePath = `${parentRoutePath}${routePath === "/" ? "" : routePath}`;

    const isRouterHandler = property.value.type === "Identifier";

    if (isRouterHandler) {
      const router = this.routerBodyCache.get(property.value.name);
      if (router) {
        await this.parseRouterBody(router, parentFilePath, finalRoutePath);
      }
      return;
    }

    const isControllerHandler =
      property.value?.arguments?.[0].type === "Identifier";

    if (property.value.type === "ObjectExpression") {
      for (const prop of property.value.properties) {
        await this.parseRoute(prop, "", parentFilePath, finalRoutePath);
      }
      return;
    }

    if (isControllerHandler) {
      const [controllerNode, methodNode] = property.value.arguments;
      controllerName = controllerNode.name;
      methodName = methodNode?.value;
    }

    if (!this.routes.has(finalRoutePath)) {
      this.routes.set(finalRoutePath, new Map());
    }

    if (method === "file") {
      return;
    } else if (method === "resource") {
      const idPrefixer = (path: string) =>
        path === "/"
          ? ":id"
          : `${path}/:${toCamelCase(path.split("/").pop())}Id`;
      const resourceIdMap = [
        {
          name: "create",
          httpMethod: "post",
          prefixer: (path: string) => path,
        },
        {
          name: "update",
          httpMethod: "put",
          prefixer: idPrefixer,
        },
        {
          name: "delete",
          httpMethod: "delete",
          prefixer: idPrefixer,
        },
        {
          name: "show",
          httpMethod: "get",
          prefixer: idPrefixer,
        },
        {
          name: "list",
          httpMethod: "get",
          prefixer: (path: string) => path,
        },
      ];

      for (const resource of resourceIdMap) {
        if (!this.routes.has(resource.prefixer(finalRoutePath))) {
          this.routes.set(resource.prefixer(finalRoutePath), new Map());
        }
        this.routes
          .get(resource.prefixer(finalRoutePath))
          ?.set(resource.httpMethod, {
            controllerName: property.value.arguments[0].name,
            methodName: resource.name,
            routerPosition: { file: parentFilePath, line, column },
          });
      }
    } else {
      this.routes.get(finalRoutePath)?.set(method, {
        controllerName,
        methodName,
        routerPosition: { file: parentFilePath, line, column },
      });
    }
  }

  private async parseRouterBody(
    body: any,
    parentFilePath: string,
    parentRoutePath = "",
  ) {
    for (const node of body) {
      if (node.key.name === "routes") {
        for (const property of node.value.properties) {
          const routePath = property.original.key.value;
          await this.parseRoute(
            property,
            routePath,
            parentFilePath,
            parentRoutePath,
          );
        }
      }
    }
  }

  private async parseRootRouter(rootApiRouterPath: string) {
    await this.parseRouterBody(this.rootRouterBody, rootApiRouterPath);
  }

  public async parse(
    cacheFilePath: string | null,
    filePath: string,
    isRoot = true,
    name = "",
  ) {
    console.log({ ROOT, filePath });
    const file = await this.parseFile(join(ROOT, filePath));
    for (const body of file.program.body) {
      if (!this.isNodeShouldBeParsed(body)) continue;
      if (body.type === "ImportDeclaration") {
        await this.parseImportDeclaration(body, filePath);
        continue;
      }

      if (this.isRouterNode(body)) {
        if (body.type === "ExportDefaultDeclaration") {
          if (isRoot) {
            this.rootRouterBody = body.declaration.body.body;
          } else {
            this.routerBodyCache.set(name, body);
          }
        } else if (body.type === "ExportNamedDeclaration") {
          this.routerBodyCache.set(
            body?.declaration?.id?.name,
            body.declaration.body.body,
          );
        } else {
          this.routerBodyCache.set(body?.id?.name, body.body.body);
        }
        continue;
      }

      if (body?.superClass.name === "Controller") {
        await this.parseControllerBody(body.body.body, body.id.name, filePath);
      }
      if (body?.superClass.name === "ResourceController") {
        await this.parseControllerBody(body.body.body, body.id.name, filePath);
      }
    }

    if (isRoot) {
      await this.parseRootRouter(filePath);
      await this.writeManifest(cacheFilePath);
    }
  }

  public async run(filePath: string) {
    const cacheId = generateGitDiffId();
    const cacheFilePath = join(this.manifestCacheDir, `${cacheId}.json`);
    if (existsSync(cacheFilePath)) {
      console.log(await Bun.file(cacheFilePath).text());
    } else {
      await this.parse(cacheFilePath, filePath, true);
    }
  }
}
