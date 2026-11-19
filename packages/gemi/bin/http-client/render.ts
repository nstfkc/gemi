import {
  invalidPackage,
  kotlinString,
  renderClass,
  renderEnum as kotlinEnum,
  renderUnion as kotlinUnion,
} from "../ai-client/kotlin";
import { pascalCase, type NamedType, type Property, type TypeRef } from "../ai-client/model";
import {
  renderStruct,
  renderEnum as swiftEnum,
  renderUnion as swiftUnion,
  swiftLiteralCase,
  swiftString,
} from "../ai-client/swift";
import type { HttpApiModel } from "./model";
import { patchCall } from "./patch";

type Literal = string | number | boolean;
type LiteralType = { name: string; value: Literal };

// A singleton wire value becomes its own native type. Reserve the extractor's
// names first so nested fields and generated literal names cannot shadow them.
function nativeModels(api: HttpApiModel) {
  const names = new Set(api.types.map((type) => type.name));
  const literals: LiteralType[] = [];
  let usesJson = false;
  function fieldType(type: TypeRef, name: string): TypeRef {
    switch (type.kind) {
      case "array":
        return { ...type, item: fieldType(type.item, name + "Item") };
      case "map":
        return { ...type, value: fieldType(type.value, name + "Value") };
      case "nullable":
        return { ...type, inner: fieldType(type.inner, name) };
      case "named":
        return type;
      case "json":
        usesJson = true;
        return type;
      case "never":
        throw new Error(`${name}: HTTP object rendering does not support ${type.kind} fields yet`);
      default: {
        if (type.literal === undefined) return type;
        let unique = name;
        for (let i = 2; names.has(unique); i++) unique = name + i;
        names.add(unique);
        literals.push({ name: unique, value: type.literal });
        return { kind: "named", name: unique };
      }
    }
  }
  const types = api.types.map((type): NamedType<boolean> => {
    if (type.kind !== "object") return type;
    const properties: Property[] = type.properties.map((p) => ({
      ...p,
      type: fieldType(p.type, type.name + pascalCase(p.key)),
    }));
    return { ...type, properties };
  });
  // A variant that extraction kept as raw JSON has no native class to implement
  // the union. Preserve the whole payload on both platforms in that case.
  const rawUnions = new Set(
    types
      .filter((type) => type.kind === "union" && type.variants.some((v) => v.type.kind !== "named"))
      .map((type) => type.name),
  );
  return { types, literals, rawUnions, usesJson: usesJson || rawUnions.size > 0 };
}

function swiftLiteral({ name, value }: LiteralType): string[] {
  const scalar =
    typeof value === "string" ? "String" : typeof value === "boolean" ? "Bool" : "Double";
  const wire = typeof value === "string" ? swiftString(value) : String(value);
  const literalCase = swiftLiteralCase(value);
  return [
    `public enum ${name}: Codable, Hashable, Sendable {`,
    `  case ${literalCase}`,
    "",
    "  public init(from decoder: Decoder) throws {",
    "    let container = try decoder.singleValueContainer()",
    `    guard try container.decode(${scalar}.self) == ${wire} else {`,
    `      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected ${name}")`,
    "    }",
    `    self = .${literalCase}`,
    "  }",
    "",
    "  public func encode(to encoder: Encoder) throws {",
    "    var container = encoder.singleValueContainer()",
    `    try container.encode(${wire} as ${scalar})`,
    "  }",
    "}",
  ];
}

function kotlinLiteral({ name, value }: LiteralType, packageName: string): string[] {
  const scalar =
    typeof value === "string" ? "String" : typeof value === "boolean" ? "Boolean" : "Double";
  let wire = typeof value === "string" ? kotlinString(value) : String(value);
  if (typeof value === "number" && !/[.e]/i.test(wire)) wire += ".0";
  return [
    `@Serializable(with = ${name}.Serializer::class)`,
    `public data object ${name} {`,
    `  public object Serializer : KSerializer<${name}> {`,
    `    override val descriptor = PrimitiveSerialDescriptor("${packageName}.${name}", PrimitiveKind.${scalar.toUpperCase()})`,
    `    override fun deserialize(decoder: Decoder): ${name} {`,
    `      if (decoder.decode${scalar}() != ${wire}) throw SerializationException("Unexpected ${name}")`,
    `      return ${name}`,
    "    }",
    `    override fun serialize(encoder: Encoder, value: ${name}) = encoder.encode${scalar}(${wire})`,
    "  }",
    "}",
  ];
}

/** Models for the whole API, optionally with a callable PATCH route. */
export function renderHttpSwift(api: HttpApiModel, patchKey?: string): string {
  const { types, literals, usesJson, rawUnions } = nativeModels(api);
  const defaults = new Map(
    literals.map(({ name, value }) => [name, "." + swiftLiteralCase(value)]),
  );
  const declarations = types.map((type) => {
    switch (type.kind) {
      case "object":
        return renderStruct(type.name, type.properties, defaults);
      case "enum":
        return swiftEnum(type.name, type.values);
      case "union":
        return rawUnions.has(type.name)
          ? [`public typealias ${type.name} = JSONValue`]
          : swiftUnion(type.name, type.discriminant, type.variants);
    }
  });
  if (patchKey) {
    const call = patchCall(api, patchKey);
    const segments = [...call.segments.map(swiftString), "id"].join(", ");
    declarations.push([
      `extension ${call.error}: GemiHTTPRouteError {`,
      `  public static var declaredStatus: Int { ${call.status} }`,
      "}",
      "",
      "extension GemiHTTPClient {",
      `  public func ${call.name}(id: String, body: ${call.body}) async throws -> ${call.output} {`,
      `    try await send(method: "PATCH", segments: [${segments}], body: body, response: ${call.output}.self,`,
      `                   rejection: ${call.error}.self)`,
      "  }",
      "}",
    ]);
  }
  return (
    [
      [
        `// Generated from ${api.source}. Do not edit.`,
        "import Foundation",
        ...(usesJson ? ["import GemiChat"] : []),
        ...(patchKey ? ["import GemiHTTP"] : []),
      ],
      ...declarations,
      ...literals.map(swiftLiteral),
    ]
      .map((block) => block.join("\n"))
      .join("\n\n") + "\n"
  );
}

export function renderHttpKotlin(api: HttpApiModel, packageName: string, patchKey?: string): string {
  const invalid = invalidPackage(packageName);
  if (invalid) throw new Error(invalid);
  const { types, literals, usesJson, rawUnions } = nativeModels(api);
  const defaults = new Set(literals.map((literal) => literal.name));
  const imports = new Set<string>();
  if (usesJson) imports.add("kotlinx.serialization.json.JsonElement");
  if (literals.length) {
    for (const name of [
      "KSerializer",
      "SerializationException",
      "descriptors.PrimitiveKind",
      "descriptors.PrimitiveSerialDescriptor",
      "encoding.Decoder",
      "encoding.Encoder",
    ]) {
      imports.add("kotlinx.serialization." + name);
    }
  }
  const parents = new Map<string, string>();
  for (const type of types) {
    if (type.kind === "union" && !rawUnions.has(type.name))
      for (const variant of type.variants)
        if (variant.type.kind === "named") parents.set(variant.type.name, type.name);
  }
  const declarations = types.map((type) => {
    if (rawUnions.has(type.name)) return [`public typealias ${type.name} = JsonElement`];
    imports.add("kotlinx.serialization.Serializable");
    switch (type.kind) {
      case "object":
        return renderClass(type.name, type.properties, parents.get(type.name), defaults, imports);
      case "enum":
        imports.add("kotlinx.serialization.SerialName");
        return kotlinEnum(type.name, type.values);
      case "union":
        for (const name of [
          "DeserializationStrategy",
          "SerializationException",
          "json.JsonContentPolymorphicSerializer",
          "json.JsonElement",
          "json.JsonPrimitive",
          "json.jsonObject",
        ])
          imports.add("kotlinx.serialization." + name);
        return kotlinUnion(type.name, type.discriminant, type.variants, true);
    }
  });
  if (patchKey) {
    const call = patchCall(api, patchKey);
    const segments = [...call.segments.map(kotlinString), "id"].join(", ");
    imports.add("kotlinx.serialization.json.Json");
    imports.add("dev.gemijs.http.GemiHttpClient");
    imports.add("dev.gemijs.http.GemiHttpException");
    const taken = new Set([...types, ...literals].map((type) => type.name));
    let exception = call.error + "Exception";
    for (let i = 2; taken.has(exception); i++) exception = call.error + "Exception" + i;
    declarations.push([
      `public class ${exception}(public val error: ${call.error}) : GemiHttpException(${call.status})`,
      "",
      `public suspend fun GemiHttpClient.${call.name}(id: String, body: ${call.body}): ${call.output} =`,
      `  send("PATCH", listOf(${segments}), Json.encodeToString(${call.body}.serializer(), body),`,
      `       ${call.output}.serializer(), ${call.error}.serializer(), ${call.status}, ::${exception})`,
    ]);
  }
  return (
    [
      [`// Generated from ${api.source}. Do not edit.`, `package ${packageName}`],
      [...imports].sort().map((name) => "import " + name),
      ...declarations,
      ...literals.map((literal) => kotlinLiteral(literal, packageName)),
    ]
      .filter((block) => block.length)
      .map((block) => block.join("\n"))
      .join("\n\n") + "\n"
  );
}
