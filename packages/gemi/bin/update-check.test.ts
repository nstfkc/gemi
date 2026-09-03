import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  checkForUpdate,
  formatUpdateNotice,
  reportUpdate,
  shouldCheckForUpdate,
} from "./update-check";

/**
 * The notice `gemi dev` prints, and — more to the point — every case in which
 * it must print nothing.
 *
 * A dev server that will not start because npm is unreachable is a strictly
 * worse product than one that never mentions updates, so the failure paths are
 * what this file spends its assertions on: no network, a non-200, a body of the
 * wrong shape, a linked checkout whose version is ahead of the registry. All of
 * them are silence, none of them are a thrown error.
 */

const dirs: string[] = [];
function project(version: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "gemi-update-"));
  dirs.push(dir);
  if (version !== null) {
    const pkg = join(dir, "node_modules", "gemi");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "gemi", version }));
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function respond(body: unknown, ok = true): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status: ok ? 200 : 404 }),
  ) as unknown as typeof fetch;
}

describe("shouldCheckForUpdate", () => {
  test("checks by default", () => {
    expect(shouldCheckForUpdate({})).toBe(true);
  });

  test("respects the opt-out", () => {
    expect(shouldCheckForUpdate({ GEMI_NO_UPDATE_CHECK: "1" })).toBe(false);
  });

  test("skips in CI, where nobody reads it and the request is pure latency", () => {
    expect(shouldCheckForUpdate({ CI: "true" })).toBe(false);
  });
});

describe("formatUpdateNotice", () => {
  test("names both versions and the command that acts on it", () => {
    const notice = formatUpdateNotice("0.58.0", "0.59.0")!;
    expect(notice).toContain("0.58.0 → 0.59.0");
    expect(notice).toContain("gemi upgrade");
  });

  test("points at UPGRADE.md when the minor changes", () => {
    // Pre-1.0 the minor is the breaking position — 0.55 → 0.56 required
    // deleting `gemi.d.ts` to keep typechecking.
    expect(formatUpdateNotice("0.58.0", "0.59.0")).toContain("UPGRADE.md");
  });

  test("does not, for a patch", () => {
    expect(formatUpdateNotice("0.59.0", "0.59.1")).not.toContain("UPGRADE.md");
  });

  test("is silent when the published version is the installed one", () => {
    expect(formatUpdateNotice("0.59.0", "0.59.0")).toBeNull();
  });

  test("is silent when the local build is ahead of the registry", () => {
    // Every contributor working from a linked checkout is in this state, and
    // telling them to "upgrade" to an older release would be noise forever.
    expect(formatUpdateNotice("0.60.0", "0.59.0")).toBeNull();
  });

  test("is silent when a version will not parse", () => {
    expect(formatUpdateNotice("workspace:*", "0.59.0")).toBeNull();
  });
});

describe("checkForUpdate", () => {
  test("returns a notice for a newer published version", async () => {
    const notice = await checkForUpdate({
      rootDir: project("0.58.0"),
      env: {},
      fetchImpl: respond({ version: "0.59.0" }),
    });
    expect(notice).toContain("0.58.0 → 0.59.0");
  });

  test("asks for the channel the installed version is on", async () => {
    // An rc compared against `latest` would be told to move to the older stable
    // release, which is the whole reason `channelFor` exists.
    const fetchImpl = respond({ version: "0.60.0-rc.3" });
    await checkForUpdate({
      rootDir: project("0.60.0-rc.1"),
      env: {},
      fetchImpl,
    });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/\/gemi\/rc$/);
  });

  test("is silent outside a gemi project", async () => {
    const fetchImpl = respond({ version: "9.9.9" });
    expect(await checkForUpdate({ rootDir: project(null), env: {}, fetchImpl })).toBeNull();
    // And does not reach the network to find that out.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("is silent, and makes no request, when opted out", async () => {
    const fetchImpl = respond({ version: "9.9.9" });
    expect(
      await checkForUpdate({
        rootDir: project("0.58.0"),
        env: { GEMI_NO_UPDATE_CHECK: "1" },
        fetchImpl,
      }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("is silent when the registry errors", async () => {
    expect(
      await checkForUpdate({
        rootDir: project("0.58.0"),
        env: {},
        fetchImpl: respond({}, false),
      }),
    ).toBeNull();
  });

  test("is silent when the request throws", async () => {
    // Offline. The dev server still has to start.
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    }) as unknown as typeof fetch;
    expect(await checkForUpdate({ rootDir: project("0.58.0"), env: {}, fetchImpl })).toBeNull();
  });

  test("is silent when the body is not the shape expected", async () => {
    expect(
      await checkForUpdate({
        rootDir: project("0.58.0"),
        env: {},
        fetchImpl: respond({ version: 59 }),
      }),
    ).toBeNull();
  });
});

describe("reportUpdate", () => {
  test("logs the notice", async () => {
    const log = vi.fn();
    await reportUpdate(
      { rootDir: project("0.58.0"), env: {}, fetchImpl: respond({ version: "0.59.0" }) },
      log,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("0.59.0");
  });

  test("logs nothing when there is nothing to say", async () => {
    const log = vi.fn();
    await reportUpdate(
      { rootDir: project("0.59.0"), env: {}, fetchImpl: respond({ version: "0.59.0" }) },
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });

  test("never rejects — `dev` does not await it, so a rejection is unhandled", async () => {
    const log = vi.fn(() => {
      throw new Error("stdout is closed");
    });
    await expect(
      reportUpdate(
        { rootDir: project("0.58.0"), env: {}, fetchImpl: respond({ version: "0.59.0" }) },
        log,
      ),
    ).resolves.toBeUndefined();
  });
});
