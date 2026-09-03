/**
 * The one npm registry read the CLI makes: what version is published under a
 * dist-tag.
 *
 * `GET /gemi/<tag>` returns that single version's manifest rather than the full
 * packument, which for gemi is several hundred kilobytes of every version ever
 * published. Both callers want one string out of it.
 */

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface FetchPublishedVersionOptions {
  timeoutMs?: number;
  registry?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The version published under `tag`, or `null` for any reason it could not be
 * read — offline, a proxy that 403s, a registry that has never heard of gemi, a
 * body that is not the shape expected.
 *
 * Never throws. Both callers are advisory: `dev` prints a notice and `upgrade`
 * falls back to reporting that it could not resolve a target. Neither is a
 * reason to fail a command the user actually asked for, and a network error on
 * a plane should not stop a dev server from starting.
 */
export async function fetchPublishedVersion(
  tag: string,
  options: FetchPublishedVersionOptions = {},
): Promise<string | null> {
  const {
    timeoutMs = 2000,
    // `GEMI_REGISTRY` mirrors what `npm_config_registry` does for npm — an
    // escape hatch for a corporate mirror, and how the tests avoid the network.
    registry = process.env.GEMI_REGISTRY ?? DEFAULT_REGISTRY,
    fetchImpl = fetch,
  } = options;

  // Not `AbortSignal.timeout()`: the signal has to be abortable in tests
  // without waiting out the real timer, and the explicit timer is cleared on
  // every path below so a resolved request cannot hold the event loop open —
  // which for `dev`, whose CLI process outlives the check, would be a hang.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${registry.replace(/\/+$/, "")}/gemi/${encodeURIComponent(tag)}`,
      {
        signal: controller.signal,
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
