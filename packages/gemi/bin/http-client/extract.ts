import path from "node:path";
import type * as TS from "typescript";
import {
  compilerOptions,
  exportedType,
  GenerateClientError,
  specifier,
  TypeMapper,
} from "../ai-client/extract";
import { pascalCase, type TypeRef } from "../ai-client/model";
import type { HttpApiModel, HttpRouteModel } from "./model";

export type RouterReference = { file: string; exportName: string };

/** Read a router class or instance. The app is never imported or instantiated. */
export function extractHttpApi(
  ts: typeof TS,
  reference: RouterReference,
  { cwd = process.cwd() }: { cwd?: string } = {},
): HttpApiModel {
  const file = path.resolve(cwd, reference.file);
  if (!ts.sys.fileExists(file)) throw new GenerateClientError(`${reference.file} does not exist.`);
  const options = compilerOptions(ts, file);
  const first = ts.createProgram({ rootNames: [file], options });
  const sourceFile = first.getSourceFile(file);
  if (!sourceFile) throw new GenerateClientError(`${reference.file} is not a TypeScript module.`);
  const checker = first.getTypeChecker();
  const { type } = exportedType(ts, checker, sourceFile, reference);
  const instance = type.getConstructSignatures()[0]?.getReturnType() ?? type;
  // Find the app's own ApiRouter declaration, including through intermediate
  // subclasses. A second gemi installation must not supply its CreateRPC.
  function routerFile(type: TS.Type): string | undefined {
    const declaration = type
      .getSymbol()
      ?.getDeclarations()
      ?.find(
        (node) =>
          ts.isClassDeclaration(node) &&
          node.name?.text === "ApiRouter" &&
          /\/http\/ApiRouter\.(d\.)?ts$/.test(node.getSourceFile().fileName),
      );
    if (declaration) return declaration.getSourceFile().fileName;
    return type.getBaseTypes()?.map(routerFile).find(Boolean);
  }
  const apiRouterFile = routerFile(instance);
  if (!apiRouterFile) {
    throw new GenerateClientError(
      `${reference.file}#${reference.exportName} is not an ApiRouter class or instance.`,
    );
  }

  const probe = path.join(path.dirname(file), `__gemi_http_client_${process.pid}.ts`);
  const source = [
    `import type { ApiRouterHandler, CreateRPC } from ${JSON.stringify(specifier(probe, apiRouterFile))};`,
    `import type * as routerModule from ${JSON.stringify(specifier(probe, file))};`,
    `type Export = (typeof routerModule)[${JSON.stringify(reference.exportName)}];`,
    `type Router = ${type.getConstructSignatures().length ? "InstanceType<Export>" : "Export"};`,
    `type Shape<T> = T extends ApiRouterHandler<infer I, infer O, infer P, infer E> ? { input: I; response: Awaited<O>; params: P; error: E } : never;`,
    `type RPC = CreateRPC<Router>;`,
    // Agent/voice entries are path-only keys, not METHOD:/path entries.
    `export type Routes = { [K in keyof RPC as K extends \`GET:\${string}\` | \`POST:\${string}\` | \`PUT:\${string}\` | \`PATCH:\${string}\` | \`DELETE:\${string}\` ? K : never]: Shape<RPC[K]> };`,
  ].join("\n");
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === probe
      ? ts.createSourceFile(fileName, source, languageVersion)
      : getSourceFile.call(host, fileName, languageVersion, ...rest);
  host.fileExists = (fileName) => fileName === probe || fileExists.call(host, fileName);
  host.readFile = (fileName) => (fileName === probe ? source : readFile.call(host, fileName));
  const program = ts.createProgram({
    rootNames: [file, probe],
    options,
    host,
    oldProgram: first,
  });
  const probeFile = program.getSourceFile(probe)!;
  const diagnostics = [
    ...program.getSyntacticDiagnostics(probeFile),
    ...program.getSemanticDiagnostics(probeFile),
  ];
  if (diagnostics.length) {
    throw new GenerateClientError(
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => cwd,
        getNewLine: () => "\n",
      }),
    );
  }
  const secondChecker = program.getTypeChecker();
  const declaration = probeFile.statements.find(
    (node): node is TS.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "Routes",
  )!;
  const routesType = secondChecker.getTypeAtLocation(declaration.name);
  const mapper = new HttpTypeMapper(ts, secondChecker);
  const routes = secondChecker
    .getPropertiesOfType(routesType)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((route): HttpRouteModel => {
      const key = route.name;
      const colon = key.indexOf(":");
      const method = key.slice(0, colon) as HttpRouteModel["method"];
      const routePath = key.slice(colon + 1);
      const shape = secondChecker.getTypeOfSymbol(route);
      const member = (name: string) => {
        const property = shape.getProperty(name);
        if (!property) throw new GenerateClientError(`Could not resolve ${key}'s ${name} type.`);
        return secondChecker.getTypeOfSymbol(property);
      };
      const base = pascalCase(key);
      const response = member("response");
      return {
        key,
        method,
        path: routePath,
        pathParameters: routePath
          .split("/")
          .filter((part) => part.startsWith(":"))
          .map((part) => ({
            name: part.slice(1).replace(/\?$/, ""),
            optional: part.endsWith("?"),
          })),
        params: mapper.map(member("params"), `${base}Params`, `${key} params`),
        input: {
          location: method === "GET" ? "query" : "body",
          type: mapper.map(member("input"), `${base}Input`, `${key} input`),
        },
        response:
          response.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)
            ? { kind: "void" }
            : mapper.map(response, `${base}Response`, `${key} response`),
        error: mapper.map(member("error"), `${base}Error`, `${key} error`),
      };
    });
  return {
    source: `${path.relative(cwd, file).split(path.sep).join("/")}#${reference.exportName}`,
    routes,
    types: mapper.types,
    warnings: mapper.warnings,
  };
}

/** Keep AI output unchanged. Its mapper drops void from unions; HTTP cannot
 * claim a definite response body when some branches return nothing. */
class HttpTypeMapper extends TypeMapper {
  constructor(
    private httpTs: typeof TS,
    checker: TS.TypeChecker,
  ) {
    super(httpTs, checker);
  }

  override map(type: TS.Type, name: string, where: string): TypeRef {
    if (
      type.isUnion() &&
      type.types.some(
        (member) =>
          member.flags & this.httpTs.TypeFlags.Void ||
          (where.endsWith(" response") && member.flags & this.httpTs.TypeFlags.Undefined),
      )
    ) {
      this.warnings.push(
        `${where}: a union containing void/undefined has no supported HTTP body shape; kept as raw JSON.`,
      );
      return { kind: "json" };
    }
    return super.map(type, name, where);
  }
}
