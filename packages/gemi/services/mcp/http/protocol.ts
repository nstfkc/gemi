import type { McpToolDescriptor } from "../McpRegistry";

/**
 * The MCP wire vocabulary the transport speaks, kept apart from the transport
 * so the shapes can be read in one place.
 *
 * Two eras share the endpoint (see "Versioning" in the 2026-07-28 spec):
 *
 * - **modern** (`2026-07-28`): stateless. Every request carries its protocol
 *   version and the client's capabilities in `_meta`, and the transport keeps
 *   nothing between requests. Server-to-client requests (elicitation) are
 *   returned as an `input_required` result and the client retries.
 * - **legacy** (`2025-03-26` to `2025-11-25`): an `initialize` handshake opens
 *   a session named by `Mcp-Session-Id`, and the server sends its own requests
 *   on the response stream of the call they belong to.
 */

export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export type LegacyVersion = (typeof LEGACY_VERSIONS)[number];

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** JSON-RPC's own codes, and the ones the MCP spec allocates. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
} as const;

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    /** The HTTP status the response goes out with. */
    readonly status = 200,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export function errorResponse(id: JsonRpcId | null, error: JsonRpcError): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    },
  };
}

/** A JSON-RPC message, told apart by its members. */
export type Incoming =
  | { kind: "request"; message: JsonRpcRequest & { id: JsonRpcId } }
  | { kind: "notification"; message: JsonRpcRequest }
  | { kind: "response"; message: JsonRpcResponse & { id: JsonRpcId } };

export function classify(body: unknown): Incoming {
  if (Array.isArray(body)) {
    // Batches were in 2025-03-26 only, and no client this transport serves
    // sends one.
    throw new JsonRpcError(ErrorCode.InvalidRequest, "Batched requests are not supported.", undefined, 400);
  }
  if (typeof body !== "object" || body === null || (body as any).jsonrpc !== "2.0") {
    throw new JsonRpcError(ErrorCode.InvalidRequest, "Not a JSON-RPC 2.0 message.", undefined, 400);
  }
  const message = body as Record<string, unknown>;
  const id = message.id;
  const validId = typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
  if (typeof message.method === "string") {
    if (message.params !== undefined && (typeof message.params !== "object" || message.params === null || Array.isArray(message.params))) {
      throw new JsonRpcError(ErrorCode.InvalidRequest, "params must be an object.", undefined, 400);
    }
    if (id === undefined) return { kind: "notification", message: message as JsonRpcRequest };
    if (!validId) {
      throw new JsonRpcError(ErrorCode.InvalidRequest, "id must be a string or a number.", undefined, 400);
    }
    return { kind: "request", message: message as JsonRpcRequest & { id: JsonRpcId } };
  }
  if (validId && ("result" in message || "error" in message)) {
    return { kind: "response", message: message as JsonRpcResponse & { id: JsonRpcId } };
  }
  throw new JsonRpcError(ErrorCode.InvalidRequest, "Not a JSON-RPC request, notification or response.", undefined, 400);
}

/**
 * A tool as `tools/list` describes it.
 *
 * `outputSchema` goes out as written for a modern client, which takes any
 * JSON Schema. A legacy one requires an object at its root, as it requires
 * `structuredContent` to be an object, so a tool whose output is not one is
 * listed without it there and answers text only.
 */
export function toolJson(tool: McpToolDescriptor, modern: boolean): Record<string, unknown> {
  const outputSchema = tool.outputSchema?.toJSONSchema();
  const annotations = { ...tool.annotations, ...(tool.title && !modern ? { title: tool.title } : {}) };
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema.toJSONSchema(),
    ...(outputSchema && (modern || outputSchema.type === "object") ? { outputSchema } : {}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

/** Whether a legacy client may be handed `value` as `structuredContent`. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The value of an `Mcp-Name` (or `Mcp-Param-*`) header, decoded from the
 * `=?base64?…?=` sentinel when it is in one. `null` for a value the header
 * could not legally carry.
 */
export function decodeHeaderValue(value: string): string | null {
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!match) return value;
  try {
    const bytes = Buffer.from(match[1], "base64");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
