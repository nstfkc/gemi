import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import type {
  McpCaller,
  McpRegistry,
  McpToolDescriptor,
  McpToolFilter,
} from "../services/mcp/McpRegistry";
import type { RealtimeTool } from "./providers/realtime";

/**
 * The app's MCP tools in a voice call (#921), run in this process on the
 * call's sideband.
 *
 * WHY NOT THE REALTIME API'S NATIVE `mcp` TOOL. The native tool has the vendor
 * call the app's `/mcp` endpoint with an `authorization` the session carries.
 * The browser holds the call's data channel, and that channel delivers
 * `session.created` / `session.updated` with the session's tools. Nothing the
 * vendors document says the `mcp` tool's `authorization` (or its `headers`) is
 * left out of those events, so a token in it has to be assumed visible to the
 * browser. The native tool also runs the calls at the vendor: the server sees
 * them only after the fact, so it can't refuse, rate-limit or meter them
 * before they run, and the endpoint has to be reachable from the internet.
 *
 * So the calls come to the server instead, like every other tool call of the
 * voice: the model calls a plain function tool, the bridge receives it on the
 * sideband, and runs it here through `McpRegistry.execute`. That means:
 *
 * - No token is minted at all. The caller is a principal built here from the
 *   user `start` saw, exactly as the MCP endpoint builds one from a verified
 *   credential: `{ kind: "remote", principal: { user, via: "voice", id, scopes } }`.
 * - The registry applies its remote rules: only tools exposed to remote
 *   callers and reached by `scopes`, features checked per call, and nothing
 *   of the browser's own request crosses over (the route runs as the
 *   principal's user).
 * - `authorize` runs before each call (keep it on the session's site, say),
 *   and the bridge's limits and `onToolCall` hook apply, the same hook chain
 *   as `onUsage`, so `VoiceHangup` works there too.
 *
 * Tools with `requiresApproval` are left out. A voice call has no approval
 * screen, and the registry refuses a remote call to such a tool without one.
 */

/** A tool the voice model may call that the bridge runs in this process. */
export type VoiceToolHandler = {
  /** What the voice model sees: name, description, parameters. */
  tool: RealtimeTool;
  /**
   * Runs one call. `input` is the model's arguments, parsed from JSON and not
   * validated: validate them. Throw a `ToolError` for a failure the model
   * should read; any other error reaches the model as "The tool failed."
   */
  run(input: unknown, info: VoiceToolRunInfo): Promise<unknown>;
  /** Overrides `limits.toolTimeoutMs` for this tool. */
  timeoutMs?: number;
};

export type VoiceToolRunInfo = {
  sessionId: string;
  /** Aborted when the call takes longer than its timeout. */
  signal: AbortSignal;
};

/** One call to a `VoiceToolHandler`, as `authorize` sees it. */
export type VoiceToolCall = { name: string; input: unknown; sessionId: string };

export type VoiceMcpOptions = {
  /** The app's registry: `app(McpRegistry)`. */
  registry: McpRegistry<any>;
  /** Narrows the tools, as `McpRegistry.list` does. */
  filter?: McpToolFilter;
  /**
   * The scopes this call's principal carries, which decide the tools it sees
   * and may call. Default: every scope the registry declares.
   */
  scopes?: readonly string[];
  /**
   * Before each call. Throw a `ToolError` to refuse with a sentence the model
   * reads (a tool aimed at another site), or a `VoiceHangup` to end the call.
   */
  authorize?: (call: VoiceToolCall) => void | Promise<void>;
  /** Per call. Default: `limits.toolTimeoutMs`. */
  timeoutMs?: number;
};

/** Where an MCP call made from a voice call is dispatched from. Never sent. */
const VOICE_MCP_URL = "http://gemi.internal/__gemi__/voice/mcp";

/**
 * The registry's tools as `VoiceToolHandler`s, for the user `user`. Call it
 * inside the request that starts the call: features are evaluated against it
 * for the listing (and again, per call, by `execute`).
 *
 * Throws when `user` is empty: MCP tools run as a signed-in user, never as
 * nobody.
 */
export async function mcpVoiceTools(
  options: VoiceMcpOptions,
  who: { user: unknown; sessionId: string },
): Promise<VoiceToolHandler[]> {
  if (!who.user) {
    throw new Error(
      "Voice MCP tools run as the signed-in user, and this voice session has none. Give `mcp` only to a signed-in user's session.",
    );
  }
  const { registry } = options;
  const scopes = options.scopes ?? registry.scopes().map((scope) => scope.name);
  const callerFor = (req: HttpRequest<any, any>): McpCaller => ({
    kind: "remote",
    req,
    principal: {
      user: who.user as never,
      via: "voice",
      id: `voice:${who.sessionId}`,
      scopes,
    },
  });

  const descriptors: McpToolDescriptor[] = await registry.available(
    callerFor(serverRequest()),
    options.filter,
  );
  return descriptors
    .filter((descriptor) => !descriptor.requiresApproval)
    .map((descriptor) => ({
      tool: {
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.inputSchema,
      },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      run: (input, info) => {
        const req = serverRequest();
        // A request scope of its own, carrying the user, as `startTurn` opens
        // one: the call runs long after the request that started it.
        return RequestContext.run(
          req,
          async () => {
            await options.authorize?.({ name: descriptor.name, input, sessionId: info.sessionId });
            return registry.execute(callerFor(req), descriptor.name, input, undefined, {
              signal: info.signal,
            });
          },
          { user: who.user as never },
        );
      },
    }));
}

function serverRequest(): HttpRequest<any, any> {
  return new HttpRequest<any, any>(
    new Request(VOICE_MCP_URL, { method: "POST" }),
    {},
    "api",
    new URL(VOICE_MCP_URL).pathname,
  );
}
