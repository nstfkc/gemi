import { pascalCase, type TypeRef } from "../ai-client/model";
import type { HttpApiModel } from "./model";

/** Select one JSON PATCH with a trailing string ID and a single typed rejection. */
export function patchCall(api: HttpApiModel, key: string) {
  const route = api.routes.find((item) => item.key === key);
  if (!route) throw new Error(`Cannot generate a call for missing route ${key}`);

  const objects = api.types.filter((type) => type.kind === "object");
  function object(ref: TypeRef | { kind: "none" | "void" | "null" }) {
    return ref.kind === "named" ? objects.find((type) => type.name === ref.name) : undefined;
  }
  const id = object(route.params)?.properties.find((p) => p.key === "id");
  const segments = route.path.split("/").slice(1);
  const last = segments.pop();
  if (
    route.method !== "PATCH" ||
    last !== ":id" ||
    !segments.length ||
    !segments.every((part) => /^[a-zA-Z0-9_-]+$/.test(part)) ||
    !id || id.optional || id.type.kind !== "string" || id.type.literal !== undefined
  ) {
    throw new Error(`${key}: expected a PATCH path ending in a required string :id`);
  }

  const body = object(route.input.type);
  const output = object(route.response);
  const error = object(route.error);
  const status = error?.properties.find((p) => p.key === "status");
  if (!body || !output || !error || !status || status.optional || status.type.kind !== "number" ||
      status.type.literal === undefined || !Number.isInteger(status.type.literal) ||
      status.type.literal < 400 || status.type.literal > 599) {
    throw new Error(`${key}: expected object input, output and a single HTTP error status`);
  }

  return {
    name: "patch" + pascalCase(segments.join(" ")),
    segments,
    body: body.name,
    output: output.name,
    error: error.name,
    status: status.type.literal,
  };
}
