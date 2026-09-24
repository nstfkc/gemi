import { createRequire } from "node:module";
import path from "node:path";
import type * as TS from "typescript";
import { type AgentModel, type NamedType, type Property, type TypeRef, pascalCase } from "./model";

/**
 * An agent's client-facing types, read by the TypeScript checker.
 *
 * Read from types and not from the tool schemas, because a tool's *progress*
 * has no schema: it is whatever the generator in `execute` yields, and the
 * checker is the only thing that knows. Nor does an output inferred from
 * `execute` rather than declared. Reading everything one way means the mobile
 * client is typed exactly as `useChat` is — both come from `ToolShapesOf`.
 *
 * Nothing is imported or run. The app's modules reach its database, its env
 * and its providers at import time, and a code generator that needs all of
 * that to be up would fail in every CI job that has no secrets.
 */

export type AgentReference = {
  /** Path to the module, as given. */
  file: string;
  /** The export holding the agent. `default` for a default export. */
  exportName: string;
};

/** `app/agents/support.ts#supportAgent`; no `#` means the default export. */
export function parseAgentReference(reference: string): AgentReference {
  const hash = reference.lastIndexOf("#");
  if (hash === -1) return { file: reference, exportName: "default" };
  const file = reference.slice(0, hash);
  const exportName = reference.slice(hash + 1);
  if (!file || !exportName) {
    throw new GenerateClientError(
      `Expected <file>#<export>, e.g. app/agents/support.ts#supportAgent — got "${reference}".`,
    );
  }
  return { file, exportName };
}

/** A failure the command reports as a sentence rather than a stack. */
export class GenerateClientError extends Error {}

/**
 * The app's own TypeScript when it has one — the version its code is written
 * for — and gemi's otherwise.
 */
export async function loadTypeScript(cwd: string): Promise<typeof TS> {
  try {
    return createRequire(path.join(cwd, "package.json"))("typescript");
  } catch {
    try {
      return (await import("typescript")).default;
    } catch {
      throw new GenerateClientError(
        "ai:generate-client reads your agent's types with the TypeScript compiler, and it is " +
          "not installed. Add it with `bun add -d typescript`.",
      );
    }
  }
}

export function extractAgent(
  ts: typeof TS,
  reference: AgentReference,
  { cwd = process.cwd(), name }: { cwd?: string; name?: string } = {},
): AgentModel {
  const file = path.resolve(cwd, reference.file);
  if (!ts.sys.fileExists(file)) {
    throw new GenerateClientError(`${reference.file} does not exist.`);
  }
  const options = compilerOptions(ts, file);

  // Pass one: find the agent, and the `Agent.ts` that declares its class.
  const first = ts.createProgram({ rootNames: [file], options });
  const checker = first.getTypeChecker();
  const { type: agentType, name: exported } = exportedType(
    ts,
    checker,
    first.getSourceFile(file)!,
    reference,
  );
  const agentFile = agentType.getSymbol()?.getDeclarations()?.[0]?.getSourceFile().fileName;
  if (agentType.getSymbol()?.getName() !== "Agent" || !agentFile) {
    throw new GenerateClientError(
      `${reference.file}#${reference.exportName} is not an Agent — it is ` +
        `\`${checker.typeToString(agentType)}\`. Point at the value \`Agent.create(...)\` returned.`,
    );
  }

  // Pass two: ask the checker for `ToolShapesOf<typeof agent>`, through a
  // module that exists only in this compiler host. Imported from the file that
  // declares the agent's own class, so it is the app's copy of gemi doing the
  // erasing — a second copy's `AgentTool` would not match the first's, and
  // every tool would come out as `never`.
  const probe = path.join(path.dirname(file), `__gemi_generate_client_${process.pid}.ts`);
  const source = [
    `import type { OutputOf, ToolShapesOf } from ${JSON.stringify(specifier(probe, agentFile))};`,
    `import type * as agentModule from ${JSON.stringify(specifier(probe, file))};`,
    `type TheAgent = (typeof agentModule)[${JSON.stringify(reference.exportName)}];`,
    `export type Tools = ToolShapesOf<TheAgent["tools"]>;`,
    `export type Output = OutputOf<TheAgent["output"]>;`,
  ].join("\n");
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === probe
      ? ts.createSourceFile(fileName, source, languageVersion)
      : getSourceFile.call(host, fileName, languageVersion, ...rest);
  host.fileExists = (fileName) => fileName === probe || fileExists.call(host, fileName);
  host.readFile = (fileName) => (fileName === probe ? source : readFile.call(host, fileName));

  const second = ts.createProgram({ rootNames: [file, probe], options, host, oldProgram: first });
  const probeFile = second.getSourceFile(probe)!;
  const alias = (aliasName: string) => {
    const declaration = probeFile.statements.find(
      (statement): statement is TS.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === aliasName,
    )!;
    return second.getTypeChecker().getTypeAtLocation(declaration.name);
  };

  const mapper = new TypeMapper(ts, second.getTypeChecker());
  // `export default supportAgent` names the type after `supportAgent`; an
  // anonymous `export default Agent.create(...)` after the file.
  const agentName = name ?? pascalCase(exported === "default" ? path.parse(file).name : exported);
  const toolsType = alias("Tools");
  const tools = mapper.checker.getPropertiesOfType(toolsType).map((tool) => {
    const shape = mapper.checker.getTypeOfSymbol(tool);
    const member = (key: string) => mapper.checker.getTypeOfSymbol(shape.getProperty(key)!);
    const base = pascalCase(tool.getName());
    return {
      name: tool.getName(),
      input: mapper.map(member("input"), `${base}Input`, `${tool.getName()}'s input`),
      output: mapper.map(member("output"), `${base}Output`, `${tool.getName()}'s output`),
      progress: mapper.map(member("progress"), `${base}Progress`, `${tool.getName()}'s progress`),
    };
  });
  const output = mapper.map(alias("Output"), "StructuredOutput", "the agent's output");

  return {
    name: agentName,
    source: `${path.relative(cwd, file).split(path.sep).join("/")}#${reference.exportName}`,
    tools,
    output,
    types: mapper.types,
    warnings: mapper.warnings,
  };
}

function compilerOptions(ts: typeof TS, file: string): TS.CompilerOptions {
  const configPath = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  let options: TS.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    options = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      path.dirname(configPath),
    ).options;
  }
  return {
    ...options,
    noEmit: true,
    skipLibCheck: true,
    // Forced on whatever the app compiles with. Without it `string | null` is
    // `string` and an optional key's `T | undefined` is `T`, so a nullable
    // field would come out required on the phone — and gemi itself compiles
    // with `strict: false`, so this is the likely case, not the edge one.
    strictNullChecks: true,
  };
}

function exportedType(
  ts: typeof TS,
  checker: TS.TypeChecker,
  sourceFile: TS.SourceFile,
  reference: AgentReference,
): { type: TS.Type; name: string } {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  let symbol = exports.find((candidate) => candidate.getName() === reference.exportName);
  if (!symbol) {
    const names = exports.map((candidate) => candidate.getName()).join(", ") || "nothing";
    throw new GenerateClientError(
      `${reference.file} has no export named "${reference.exportName}". It exports: ${names}.`,
    );
  }
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return { type: checker.getTypeOfSymbolAtLocation(symbol, sourceFile), name: symbol.getName() };
}

/** An import specifier from `from` to `to`, extension dropped. */
function specifier(from: string, to: string): string {
  const relative = path
    .relative(path.dirname(from), to)
    .split(path.sep)
    .join("/")
    .replace(/(\.d)?\.(ts|tsx|mts|cts)$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Checker types to the model. Every shape it does not map becomes `json` with
 * a warning naming where it was, so a generated client never silently claims
 * to know a type it does not.
 */
class TypeMapper {
  types: NamedType[] = [];
  warnings: string[] = [];
  private names = new Set<string>([
    // What the renderers declare beside the named types.
    "ToolCall",
    "ToolResult",
    "Pending",
    "Output",
  ]);
  /** Types being mapped right now, for a recursive type. */
  private inProgress = new Set<TS.Type>();

  constructor(
    private ts: typeof TS,
    readonly checker: TS.TypeChecker,
  ) {}

  map(type: TS.Type, name: string, where: string): TypeRef {
    const { ts, checker } = this;
    const flags = type.flags;

    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: "json" };
    if (flags & ts.TypeFlags.Never) return { kind: "never" };
    if (flags & ts.TypeFlags.StringLike) return { kind: "string" };
    if (flags & ts.TypeFlags.NumberLike) return { kind: "number" };
    if (flags & ts.TypeFlags.BooleanLike) return { kind: "boolean" };
    if (type.isUnion()) return this.union(type, name, where);
    if (checker.isArrayType(type)) {
      const [item] = checker.getTypeArguments(type as TS.TypeReference);
      return { kind: "array", item: this.map(item!, `${name}Item`, `${where}[]`) };
    }
    if (checker.isTupleType(type)) return this.unsupported(type, where, "a tuple");
    if (flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
      return this.object(type, name, where);
    }
    return this.unsupported(type, where, "a type with no JSON shape");
  }

  private union(type: TS.UnionType, name: string, where: string): TypeRef {
    const { ts } = this;
    let nullable = false;
    const members = type.types.filter((member) => {
      if (member.flags & ts.TypeFlags.Null) nullable = true;
      return !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));
    });
    const wrap = (inner: TypeRef): TypeRef =>
      nullable && inner.kind !== "json" ? { kind: "nullable", inner } : inner;

    if (members.length === 0) return { kind: "json" };
    // `boolean` is `true | false` to the checker.
    if (members.every((member) => member.flags & ts.TypeFlags.BooleanLike)) {
      return wrap({ kind: "boolean" });
    }
    if (members.length === 1) return wrap(this.map(members[0]!, name, where));
    if (members.every((member) => member.isStringLiteral())) {
      const values = [...new Set(members.map((member) => (member as TS.StringLiteralType).value))];
      return wrap(this.named(name, (unique) => ({ kind: "enum", name: unique, values })));
    }
    if (members.every((member) => member.flags & ts.TypeFlags.StringLike)) {
      return wrap({ kind: "string" });
    }
    if (members.every((member) => member.flags & ts.TypeFlags.NumberLike)) {
      return wrap({ kind: "number" });
    }
    const discriminant = this.discriminantOf(members);
    if (discriminant) {
      return wrap(
        this.named(name, (unique) => ({
          kind: "union",
          name: unique,
          discriminant,
          variants: members.map((member) => {
            const value = this.literalAt(member, discriminant)!;
            const type = this.map(member, `${unique}${pascalCase(value)}`, `${where} (${value})`);
            return { value, type };
          }),
        })),
      );
    }
    return this.unsupported(type, where, "a union that is not told apart by one string member");
  }

  /** The key every member has as a distinct string literal, if one does. */
  private discriminantOf(members: TS.Type[]): string | undefined {
    if (!members.every((member) => this.isPlainObject(member))) return undefined;
    const keys = this.checker
      .getPropertiesOfType(members[0]!)
      .map((property) => property.getName());
    return keys.find((key) => {
      const values = members.map((member) => this.literalAt(member, key));
      return values.every((value) => value !== undefined) && new Set(values).size === values.length;
    });
  }

  private literalAt(type: TS.Type, key: string): string | undefined {
    const property = type.getProperty(key);
    if (!property) return undefined;
    const propertyType = this.checker.getTypeOfSymbol(property);
    return propertyType.isStringLiteral() ? propertyType.value : undefined;
  }

  private isPlainObject(type: TS.Type) {
    const { ts, checker } = this;
    return (
      Boolean(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) &&
      !checker.isArrayType(type) &&
      !checker.isTupleType(type)
    );
  }

  private object(type: TS.Type, name: string, where: string): TypeRef {
    const { ts, checker } = this;
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      return this.unsupported(type, where, "a function");
    }
    const properties = checker
      .getPropertiesOfType(type)
      // Symbol-keyed members (a schema's phantom brand) have no JSON key.
      .filter((property) => !property.getName().startsWith("__@"))
      // `?: undefined` is not a field. TypeScript writes one into each member
      // of an inferred union of object literals for every key the others have
      // — `yield { stage: "a", pid }` then `yield { stage: "b", text }` gives
      // the first a `text?: undefined` — and it is never on the wire.
      .filter((property) => !(checker.getTypeOfSymbol(property).flags & ts.TypeFlags.Undefined));
    const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
    if (properties.length === 0 && index) {
      return { kind: "map", value: this.map(index.type, `${name}Value`, `${where}[key]`) };
    }
    const methods = properties.filter(
      (property) => checker.getTypeOfSymbol(property).getCallSignatures().length > 0,
    );
    if (methods.length > 0) {
      // A class instance — a `Date`, say. What reaches the client is whatever
      // `JSON.stringify` made of it, which the type does not describe.
      return this.unsupported(type, where, `an object with methods (${methods[0]!.getName()})`);
    }
    if (this.inProgress.has(type)) return this.unsupported(type, where, "a recursive type");

    this.inProgress.add(type);
    try {
      return this.named(name, (unique) => ({
        kind: "object",
        name: unique,
        properties: properties.map((property): Property => {
          const key = property.getName();
          // An optional key's type is `T | undefined`, and `union` drops the
          // `undefined`: absence is the property's to say, not the type's.
          return {
            key,
            optional: Boolean(property.flags & ts.SymbolFlags.Optional),
            type: this.map(
              checker.getTypeOfSymbol(property),
              `${unique}${pascalCase(key)}`,
              `${where}.${key}`,
            ),
          };
        }),
      }));
    } finally {
      this.inProgress.delete(type);
    }
  }

  /**
   * Reserves a unique name and registers the type under it. The name is taken
   * before `build` runs so members named inside it cannot claim it first, and
   * the type is listed before its members so a reader meets it first.
   */
  private named(name: string, build: (unique: string) => NamedType): TypeRef {
    let unique = name;
    for (let n = 2; this.names.has(unique); n++) unique = `${name}${n}`;
    this.names.add(unique);
    const slot = this.types.length;
    this.types.push(undefined as unknown as NamedType);
    this.types[slot] = build(unique);
    return { kind: "named", name: unique };
  }

  private unsupported(type: TS.Type, where: string, what: string): TypeRef {
    this.warnings.push(
      `${where}: \`${this.checker.typeToString(type)}\` is ${what}, so the client keeps it as raw JSON.`,
    );
    return { kind: "json" };
  }
}
