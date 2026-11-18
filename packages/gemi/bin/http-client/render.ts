import { invalidPackage, kotlinString, renderClass } from "../ai-client/kotlin";
import { pascalCase, type Property, type TypeRef } from "../ai-client/model";
import { renderStruct } from "../ai-client/swift";
import type { HttpApiModel } from "./model";

type Literal = string | number | boolean;
type LiteralType = { name: string; value: Literal };

// A singleton wire value becomes its own native type. Reserve the extractor's
// names first so nested fields and generated literal names cannot shadow them.
function objectModels(api: HttpApiModel) {
  const names = new Set(api.types.map((type) => type.name));
  const literals: LiteralType[] = [];
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
      case "never":
      case "json":
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
  const objects = api.types.map((type) => {
    if (type.kind !== "object")
      throw new Error(`${type.name}: HTTP object rendering does not support ${type.kind} yet`);
    const properties: Property[] = type.properties.map((p) => ({
      ...p,
      type: fieldType(p.type, type.name + pascalCase(p.key)),
    }));
    return { name: type.name, properties };
  });
  return { objects, literals };
}

function swiftLiteral({ name, value }: LiteralType): string[] {
  const scalar =
    typeof value === "string" ? "String" : typeof value === "boolean" ? "Bool" : "Double";
  const wire = JSON.stringify(value).replace(/\\\\|\\u([0-9a-f]{4})|\\b|\\f/g, (s, hex) =>
    hex ? `\\u{${hex}}` : s === "\\b" ? "\\u{8}" : s === "\\f" ? "\\u{c}" : s,
  );
  return [
    `public enum ${name}: Codable, Hashable, Sendable {`,
    "  case value",
    "",
    "  public init(from decoder: Decoder) throws {",
    "    let container = try decoder.singleValueContainer()",
    `    guard try container.decode(${scalar}.self) == ${wire} else {`,
    `      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected ${name}")`,
    "    }",
    "    self = .value",
    "  }",
    "",
    "  public func encode(to encoder: Encoder) throws {",
    "    var container = encoder.singleValueContainer()",
    `    try container.encode(${wire} as ${scalar})`,
    "  }",
    "}",
  ];
}

function kotlinLiteral({ name, value }: LiteralType): string[] {
  const scalar =
    typeof value === "string" ? "String" : typeof value === "boolean" ? "Boolean" : "Double";
  let wire = typeof value === "string" ? kotlinString(value) : String(value);
  if (typeof value === "number" && !/[.e]/i.test(wire)) wire += ".0";
  return [
    `@Serializable(with = ${name}.Serializer::class)`,
    `public data object ${name} {`,
    `  public object Serializer : KSerializer<${name}> {`,
    `    override val descriptor = ${scalar}.serializer().descriptor`,
    `    override fun deserialize(decoder: Decoder): ${name} {`,
    `      if (decoder.decode${scalar}() != ${wire}) throw SerializationException("Unexpected ${name}")`,
    `      return ${name}`,
    "    }",
    `    override fun serialize(encoder: Encoder, value: ${name}) = encoder.encode${scalar}(${wire})`,
    "  }",
    "}",
  ];
}

/** Internal data models. Transport and route methods consume these in a later step. */
export function renderHttpSwift(api: HttpApiModel): string {
  const { objects, literals } = objectModels(api);
  return (
    [
      [`// Generated from ${api.source}. Do not edit.`, "import Foundation"],
      ...objects.map(({ name, properties }) => renderStruct(name, properties)),
      ...literals.map(swiftLiteral),
    ]
      .map((block) => block.join("\n"))
      .join("\n\n") + "\n"
  );
}

export function renderHttpKotlin(api: HttpApiModel, packageName: string): string {
  const invalid = invalidPackage(packageName);
  if (invalid) throw new Error(invalid);
  const { objects, literals } = objectModels(api);
  return (
    [
      [`// Generated from ${api.source}. Do not edit.`, `package ${packageName}`],
      [
        "import kotlinx.serialization.SerialName",
        "import kotlinx.serialization.Serializable",
        ...(literals.length
          ? [
              "import kotlinx.serialization.KSerializer",
              "import kotlinx.serialization.SerializationException",
              "import kotlinx.serialization.builtins.serializer",
              "import kotlinx.serialization.encoding.Decoder",
              "import kotlinx.serialization.encoding.Encoder",
            ]
          : []),
      ],
      ...objects.map(({ name, properties }) => renderClass(name, properties, undefined)),
      ...literals.map(kotlinLiteral),
    ]
      .map((block) => block.join("\n"))
      .join("\n\n") + "\n"
  );
}
