/**
 * What `ai:generate-client` knows about an agent, independent of the language
 * it is written out in.
 *
 * The extractor turns the checker's view of `typeof agent` into this, and each
 * renderer turns this into source. Everything a renderer needs to decide is
 * decided here — names included — so two renderers given the same model name
 * the same types, and an app with an iOS and an Android client reads one
 * vocabulary in both.
 */

export type TypeRef =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  /** Anything the generator does not map: `unknown`, `any`, and the shapes it
   *  warns about. The client keeps it as a raw JSON value. */
  | { kind: "json" }
  /** Only ever a tool's progress (a tool that cannot yield) or an agent's
   *  output (an agent with no `output` schema). */
  | { kind: "never" }
  | { kind: "array"; item: TypeRef }
  /** `Record<string, T>`. */
  | { kind: "map"; value: TypeRef }
  /** `T | null`. Whether the key may be left out is the property's business. */
  | { kind: "nullable"; inner: TypeRef }
  | { kind: "named"; name: string };

export type Property = {
  /** The JSON key, exactly. */
  key: string;
  type: TypeRef;
  /** `key?:` — the key may be absent. Distinct from a nullable type, whose key
   *  is present with `null`; a server whose schema says `.nullable()` rejects
   *  an object that leaves the key out. */
  optional: boolean;
};

export type NamedType =
  | { kind: "object"; name: string; properties: Property[] }
  /** A union of string literals. */
  | { kind: "enum"; name: string; values: string[] }
  /** A union of objects told apart by one string-literal member. */
  | {
      kind: "union";
      name: string;
      discriminant: string;
      variants: { value: string; type: string }[];
    };

export type ToolModel = {
  /** The tool's name as the wire carries it. */
  name: string;
  input: TypeRef;
  output: TypeRef;
  progress: TypeRef;
};

export type AgentModel = {
  /** The type the renderers put everything under, e.g. `SupportAgent`. */
  name: string;
  /** Where it came from, for the header of the generated file. */
  source: string;
  tools: ToolModel[];
  output: TypeRef;
  /** In the order they were named, which is the order a reader meets them. */
  types: NamedType[];
  warnings: string[];
};

/** `refund_order` → `RefundOrder`, `max-steps` → `MaxSteps`. */
export function pascalCase(text: string): string {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
  if (joined === "") return "Value";
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

/** `refund_order` → `refundOrder`. */
export function camelCase(text: string): string {
  const pascal = pascalCase(text);
  if (pascal.startsWith("_")) return pascal;
  // Keep a leading acronym readable: `URLPath` → `urlPath`, not `uRLPath`.
  const leading = pascal.match(/^[A-Z]+(?=[A-Z][a-z]|[0-9]|$)/)?.[0] ?? pascal[0]!;
  return leading.toLowerCase() + pascal.slice(leading.length);
}
