import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { channelFor, compareVersions, parseVersion, readInstalledVersion } from "./version";

/**
 * The comparison both `gemi dev`'s update notice and `gemi upgrade` are built
 * on.
 *
 * Worth its own file because the two cases that matter are the two a string
 * comparison gets wrong, and both are ones gemi actually ships into:
 * `0.60.0-rc.2` vs `0.60.0-rc.10` (string order puts `.10` first), and
 * `0.60.0-rc.1` vs `0.60.0` (a prerelease sorts *below* its release). Get
 * either backwards and the notice tells a user on the newest rc to downgrade.
 */

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "gemi-version-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseVersion", () => {
  test("splits the core from the prerelease identifiers", () => {
    expect(parseVersion("0.59.0")).toEqual({ core: [0, 59, 0], prerelease: [] });
    expect(parseVersion("1.2.3-rc.4")).toEqual({
      core: [1, 2, 3],
      prerelease: ["rc", "4"],
    });
  });

  test("tolerates a leading v and discards build metadata", () => {
    expect(parseVersion("v0.59.0")).toEqual({ core: [0, 59, 0], prerelease: [] });
    // Build metadata is not part of precedence, so it must not survive into the
    // parsed shape where a comparison could accidentally read it.
    expect(parseVersion("0.59.0+abc")).toEqual({ core: [0, 59, 0], prerelease: [] });
  });

  test("rejects what is not a version", () => {
    for (const input of ["", "latest", "0.59", "0.59.0.1", "next"]) {
      expect(parseVersion(input), input).toBeNull();
    }
  });
});

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.59.0", "0.60.0")).toBeLessThan(0);
    expect(compareVersions("0.59.1", "0.59.0")).toBeGreaterThan(0);
    expect(compareVersions("0.59.0", "0.59.0")).toBe(0);
  });

  test("a prerelease sorts below the release it leads to", () => {
    expect(compareVersions("0.60.0-rc.1", "0.60.0")).toBeLessThan(0);
    expect(compareVersions("0.60.0", "0.60.0-rc.1")).toBeGreaterThan(0);
  });

  test("numeric prerelease identifiers compare numerically, not as strings", () => {
    // The whole reason this is not `a < b`: "rc.10" < "rc.2" lexically.
    expect(compareVersions("0.60.0-rc.2", "0.60.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("0.60.0-rc.10", "0.60.0-rc.2")).toBeGreaterThan(0);
  });

  test("a numeric identifier sorts below an alphanumeric one", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });

  test("a longer prerelease sorts above its own prefix", () => {
    expect(compareVersions("1.0.0-rc", "1.0.0-rc.1")).toBeLessThan(0);
  });

  test("build metadata does not affect precedence", () => {
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
  });

  test("unparseable input compares equal, so it can never read as an upgrade", () => {
    // A version string neither side understands must not produce a notice
    // telling someone to move to it.
    expect(compareVersions("workspace:*", "0.59.0")).toBe(0);
    expect(compareVersions("0.59.0", "not-a-version")).toBe(0);
  });
});

describe("channelFor", () => {
  test("a stable release is on latest", () => {
    expect(channelFor("0.59.0")).toBe("latest");
  });

  test("a release candidate is on rc", () => {
    // gemi publishes rcs under the `rc` dist-tag; compared against `latest` an
    // rc would be told to move to the older stable release.
    expect(channelFor("0.60.0-rc.2")).toBe("rc");
  });

  test("other prerelease channels use their own identifier", () => {
    expect(channelFor("1.0.0-beta.1")).toBe("beta");
  });

  test("a purely numeric prerelease names no channel and falls back to latest", () => {
    expect(channelFor("1.0.0-1")).toBe("latest");
  });

  test("an unparseable version falls back to latest", () => {
    expect(channelFor("workspace:*")).toBe("latest");
  });
});

describe("readInstalledVersion", () => {
  function install(root: string, version: unknown) {
    const dir = join(root, "node_modules", "gemi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "gemi", version }));
  }

  test("reads the version from node_modules/gemi", () => {
    const root = fixture();
    install(root, "0.59.0");
    expect(readInstalledVersion(root)).toBe("0.59.0");
  });

  test("walks up to a hoisted install", () => {
    // A monorepo package, or any app whose gemi was hoisted to the workspace
    // root — the common layout, and the one a `join(rootDir, "node_modules")`
    // lookup would miss.
    const root = fixture();
    install(root, "0.59.0");
    const nested = join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    expect(readInstalledVersion(nested)).toBe("0.59.0");
  });

  test("returns null outside a gemi project rather than throwing", () => {
    expect(readInstalledVersion(fixture())).toBeNull();
  });

  test("returns null for a manifest that is not readable as JSON", () => {
    const root = fixture();
    const dir = join(root, "node_modules", "gemi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(readInstalledVersion(root)).toBeNull();
  });

  test("returns null for a manifest with no version string", () => {
    const root = fixture();
    install(root, undefined);
    expect(readInstalledVersion(root)).toBeNull();
  });
});
