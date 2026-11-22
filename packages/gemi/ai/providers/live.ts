/**
 * Model calls from a test process (#1342).
 *
 * A test that boots the app with a real provider configured, and the keys in
 * its environment, would otherwise make real, billed calls: a forgotten fake,
 * a background job a test started, a provider picked by config. Under vitest a
 * built-in provider refuses to reach the network unless `GEMI_AI_LIVE=1`.
 *
 * Only the network is refused. A test that passes the provider its own
 * `fetchImpl` (or `webSocket`), that stubs the global `fetch`/`WebSocket`
 * (`vi.stubGlobal`), or whose provider points at this machine (`localhost`,
 * `127.0.0.1`, `::1`: a test server, a local model) is let through.
 */

// The globals as this module first saw them: a stub set later is not the
// network.
const loadedFetch = globalThis.fetch;
const loadedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

/**
 * Whether `current` is a stand-in for the real global. Under Bun, whose own
 * `fetch` and `WebSocket` are native code, that is anything that is not
 * native, so a mock installed before gemi loaded (MSW's
 * `setupServer().listen()` in a vitest setup file) counts too. Elsewhere it is
 * anything set after this module loaded.
 */
function stubbed(current: unknown, loaded: unknown): boolean {
  if (typeof Bun === "undefined") return current !== loaded;
  return (
    typeof current !== "function" ||
    !/\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(current))
  );
}

/** A built-in provider refused a network call under vitest without `GEMI_AI_LIVE=1`. */
export class LiveModelCallRefusedError extends Error {
  constructor(url: string) {
    super(
      `A model provider tried to call ${safeOrigin(url)} from a test. Tests under vitest do not ` +
        "reach real model providers: give the agent a scripted or fake provider, or set " +
        "GEMI_AI_LIVE=1 to make real (billed) calls.",
    );
    this.name = "LiveModelCallRefusedError";
  }
}

export function liveCallsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.VITEST || env.GEMI_AI_LIVE === "1";
}

/** Throws unless this process may send a real request with the global `fetch`. */
export function assertLiveFetch(url: string): void {
  if (liveCallsAllowed() || stubbed(globalThis.fetch, loadedFetch) || isLoopback(url)) return;
  throw new LiveModelCallRefusedError(url);
}

/** Throws unless this process may open a real socket with the global `WebSocket`. */
export function assertLiveWebSocket(url: string): void {
  const current = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (liveCallsAllowed() || stubbed(current, loadedWebSocket) || isLoopback(url)) return;
  throw new LiveModelCallRefusedError(url);
}

function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "a provider";
  }
}
