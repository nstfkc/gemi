import path from "node:path";
import type * as TS from "typescript";
import {
  compilerOptions,
  exportedType,
  GenerateClientError,
  specifier,
  TypeMapper,
} from "../ai-client/extract";
import { pascalCase, type TypeRef, type NamedType } from "../ai-client/model";
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
    `import type { ApiRouterHandler, CreateRPC, CreateRawHttpOutputs, HttpMethod } from ${JSON.stringify(specifier(probe, apiRouterFile))};`,
    `import type { HttpResponse, ResponseData } from ${JSON.stringify(specifier(probe, path.join(path.dirname(apiRouterFile), "HttpResponse.ts")))};`,
    `import type * as routerModule from ${JSON.stringify(specifier(probe, file))};`,
    `type Export = (typeof routerModule)[${JSON.stringify(reference.exportName)}];`,
    `type Router = ${type.getConstructSignatures().length ? "InstanceType<Export>" : "Export"};`,
    `type EmptyToVoid<O> = O extends HttpResponse<any, 204> ? void : O;`,
    `type Body<O> = Awaited<ResponseData<EmptyToVoid<O>>>;`,
    `type RPC = CreateRPC<Router>;`,
    `type Raw = CreateRawHttpOutputs<Router>;`,
    `type Shape<T, O> = T extends ApiRouterHandler<infer I, any, infer P, infer E> ? { input: I; response: Body<O>; params: P; error: E } : never;`,
    // Agent/voice entries are path-only keys, not METHOD:/path entries.
    `export type Routes = { [K in keyof RPC as K extends \`\${HttpMethod}:\${string}\` ? K : never]: Shape<RPC[K], K extends keyof Raw ? Raw[K] : never> };`,
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
  function noInput(type: TS.Type): boolean {
    if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return true;
    return (
      Boolean(type.flags & ts.TypeFlags.Object) &&
      secondChecker.getPropertiesOfType(type).length === 0 &&
      type.getCallSignatures().length === 0 &&
      type.getConstructSignatures().length === 0 &&
      secondChecker
        .getIndexInfosOfType(type)
        .every((index) => Boolean(index.type.flags & ts.TypeFlags.Never))
    );
  }
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
      const pathParameters = routePath
        .split("/")
        .filter((part) => part.startsWith(":"))
        .map((part) => ({
          name: part.slice(1).replace(/[?*]$/, ""),
          optional: part.endsWith("?"),
          catchAll: part.endsWith("*"),
        }));
      const params = member("params");
      if (!noInput(params)) {
        const declared = secondChecker
          .getPropertiesOfType(params)
          .map((p) => p.name)
          .sort();
        const actual = pathParameters.map((p) => p.name).sort();
        if (JSON.stringify(declared) !== JSON.stringify(actual))
          mapper.warnings.push(
            `${key} params: declared keys (${declared.join(", ")}) differ from path parameters (${actual.join(", ")}).`,
          );
      }
      return {
        key,
        method,
        path: routePath,
        pathParameters,
        params: noInput(params)
          ? { kind: "none" }
          : mapper.map(params, `${base}Params`, `${key} params`),
        input: {
          location: method === "GET" ? "query" : "body",
          type: noInput(member("input"))
            ? { kind: "none" }
            : mapper.map(member("input"), `${base}Input`, `${key} input`),
        },
        response:
          response.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)
            ? { kind: "void" }
            : response.flags & ts.TypeFlags.Null
              ? { kind: "null" }
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
  protected override named(name: string, build: (unique: string) => NamedType): TypeRef {
    return super.named(name, (unique) => {
      if (unique !== name)
        this.warnings.push(`HTTP type name collision: ${name} renamed to ${unique}.`);
      return build(unique);
    });
  }

  override map(type: TS.Type, name: string, where: string): TypeRef {
    if (type.isStringLiteral()) return { kind: "string", literal: type.value };
    if (type.isNumberLiteral()) return { kind: "number", literal: type.value };

    if (
      type.isUnion() &&
      type.types.some(
        (member) =>
          member.flags & this.ts.TypeFlags.Void ||
          (where.endsWith(" response") && member.flags & this.ts.TypeFlags.Undefined),
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
