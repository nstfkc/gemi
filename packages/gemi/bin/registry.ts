import { channelFor, compareVersions } from "./version";

/**
 * The npm registry reads the CLI makes: what version is published under a
 * dist-tag, and which of the tags that matter is newest.
 *
 * `GET /gemi/<tag>` returns that single version's manifest rather than the full
 * packument, which for gemi is several hundred kilobytes of every version ever
 * published. Every caller wants one string out of it.
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

/**
 * The newest version worth moving to from `installed`, across the channel it is
 * on *and* `latest`.
 *
 * Asking only the installed version's own dist-tag fixes the backwards case — an
 * rc is never told to "upgrade" onto the older stable release — but it opens a
 * forwards one, and that case is live rather than hypothetical. gemi's tags at
 * the time of writing:
 *
 *     { next: "0.49.0-rc.4", rc: "0.51.0-rc.14", latest: "0.59.0" }
 *
 * `rc` has not moved in eight minors, `next` in ten. An app on `0.51.0-rc.14`
 * that asks only `rc` is told it is current — forever, while sitting on exactly
 * the release this feature exists to move it off. So a prerelease channel asks
 * both tags and takes whichever is newer; `compareVersions` already orders
 * `0.59.0` above `0.51.0-rc.14`, so the stable release wins on its own, and a
 * channel that is still ahead of `latest` still wins when it should.
 *
 * A stable install asks only `latest`: nothing on a prerelease tag is an upgrade
 * from it, so a second request would be spent to discard the answer.
 */
export async function fetchNewestPublished(
  installed: string,
  options: FetchPublishedVersionOptions = {},
): Promise<string | null> {
  const channel = channelFor(installed);
  if (channel === "latest") return fetchPublishedVersion("latest", options);

  // In parallel, and both already swallow every failure — one tag being
  // unreachable must not cost the answer the other one has.
  const [onChannel, onLatest] = await Promise.all([
    fetchPublishedVersion(channel, options),
    fetchPublishedVersion("latest", options),
  ]);
  if (!onChannel) return onLatest;
  if (!onLatest) return onChannel;
  return compareVersions(onLatest, onChannel) > 0 ? onLatest : onChannel;
}
