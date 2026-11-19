import type { HttpMethod } from "../../http/ApiRouter";
import type { NamedType, TypeRef } from "../ai-client/model";

/** Language-neutral description shared by the native HTTP renderers. */
export type HttpRouteModel = {
  /** The exact CreateRPC key, with groups removed by the framework. */
  key: string;
  method: HttpMethod;
  path: string;
  /** Path syntax is authoritative even when HttpRequest leaves Params unknown. */
  pathParameters: { name: string; optional: boolean; catchAll: boolean }[];
  /** The declared HttpRequest Params type, separate from path syntax. */
  params: TypeRef | { kind: "none" };
  input: { location: "query" | "body"; type: TypeRef | { kind: "none" } };
  response: TypeRef | { kind: "void" } | { kind: "null" };
  /** CreateRPC's client error shape (including status), not the raw envelope. */
  error: TypeRef;
};

export type HttpApiModel = {
  source: string;
  routes: HttpRouteModel[];
  types: NamedType<boolean>[];
  warnings: string[];
};
