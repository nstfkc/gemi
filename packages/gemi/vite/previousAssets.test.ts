import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  PREVIOUS_ASSETS_RECORD,
  resolvePreviousAssets,
  restorePreviousAssets,
  stagePreviousAssets,
  type ResolvedPreviousAssets,
} from "./previousAssets";

/**
 * A tab rendered by the previous release keeps asking for that release's
 * chunks. These walk real directories through several "deploys": what the
 * outgoing release served has to be in the new `dist/client`, and what is
 * older than the grace period or the release count has to be gone.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemi-previous-assets-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

async function listAssets(clientDir: string) {
  return (await readdir(join(clientDir, "assets"), { recursive: true })).map(String).sort();
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * One deploy: the build in `from` is replaced by a fresh build of `files`,
 * written to `to` — the same directory for an in-place build.
 */
async function deploy(
  options: Partial<ResolvedPreviousAssets> & { from: string },
  to: string,
  files: Record<string, string>,
  now: Date,
) {
  const staging = await mkdtemp(join(tmpdir(), "gemi-previous-assets-staging-"));
  const resolved = { releases: 2, maxAgeMs: 7 * DAY, ...options };
  const releases = await stagePreviousAssets(resolved, staging, now);
  // What Vite's client build does to its outDir.
  await rm(to, { recursive: true, force: true });
  await write(to, files);
  const result = await restorePreviousAssets(staging, to, releases);
  await rm(staging, { recursive: true, force: true });
  return result;
}

describe("carrying the previous release's assets", () => {
  test("the outgoing release's files are in the new build, beside the new ones", async () => {
    const client = join(dir, "dist/client");
    await write(client, {
      "assets/client-v1.js": "v1",
      "assets/Home-v1.js": "home v1",
      "assets/nested/font-v1.woff2": "font",
      "index.html": "not an asset",
    });

    const result = await deploy(
      { from: client },
      client,
      {
        "assets/client-v2.js": "v2",
        "assets/Home-v2.js": "home v2",
      },
      new Date("2026-10-01T00:00:00Z"),
    );

    expect(await listAssets(client)).toEqual([
      "Home-v1.js",
      "Home-v2.js",
      "client-v1.js",
      "client-v2.js",
      "nested",
      "nested/font-v1.woff2",
    ]);
    expect(await readFile(join(client, "assets/Home-v1.js"), "utf8")).toBe("home v1");
    expect(existsSync(join(client, "index.html"))).toBe(false);
    expect(result).toEqual({ files: 3, releases: 1 });
  });

  test("a file the new build also wrote stays the new build's, and is not recorded as carried", async () => {
    const client = join(dir, "dist/client");
    await write(client, { "assets/vendor-same.js": "shared", "assets/Home-v1.js": "v1" });

    await deploy(
      { from: client },
      client,
      {
        "assets/vendor-same.js": "shared",
        "assets/Home-v2.js": "v2",
      },
      new Date("2026-10-01T00:00:00Z"),
    );

    const record = JSON.parse(await readFile(join(client, PREVIOUS_ASSETS_RECORD), "utf8"));
    expect(record.releases).toEqual([
      { retiredAt: "2026-10-01T00:00:00.000Z", files: ["assets/Home-v1.js"] },
    ]);

    // On the next deploy `vendor-same.js` is v2's own file, so it is carried
    // for v2 — had it been recorded as v1's, it would expire with v1.
    await deploy(
      { from: client, releases: 1 },
      client,
      { "assets/Home-v3.js": "v3" },
      new Date("2026-10-02T00:00:00Z"),
    );
    expect(await listAssets(client)).toEqual(["Home-v2.js", "Home-v3.js", "vendor-same.js"]);
  });

  test("keeps `releases` earlier releases, newest first", async () => {
    const client = join(dir, "dist/client");
    await write(client, { "assets/a-v1.js": "1" });
    let now = new Date("2026-10-01T00:00:00Z").getTime();
    for (const v of [2, 3, 4]) {
      now += 60_000;
      await deploy(
        { from: client, releases: 2 },
        client,
        { [`assets/a-v${v}.js`]: `${v}` },
        new Date(now),
      );
    }

    expect(await listAssets(client)).toEqual(["a-v2.js", "a-v3.js", "a-v4.js"]);
  });

  test("drops a release once it is older than the grace period", async () => {
    const client = join(dir, "dist/client");
    await write(client, { "assets/a-v1.js": "1" });
    const start = new Date("2026-10-01T00:00:00Z").getTime();

    await deploy(
      { from: client, releases: 5, maxAgeMs: 3 * DAY },
      client,
      { "assets/a-v2.js": "2" },
      new Date(start),
    );
    await deploy(
      { from: client, releases: 5, maxAgeMs: 3 * DAY },
      client,
      { "assets/a-v3.js": "3" },
      new Date(start + 2 * DAY),
    );
    expect(await listAssets(client)).toEqual(["a-v1.js", "a-v2.js", "a-v3.js"]);

    // v1 was replaced four days ago now; v2 two days ago.
    await deploy(
      { from: client, releases: 5, maxAgeMs: 3 * DAY },
      client,
      { "assets/a-v4.js": "4" },
      new Date(start + 4 * DAY),
    );
    expect(await listAssets(client)).toEqual(["a-v2.js", "a-v3.js", "a-v4.js"]);
  });

  test("reads the previous release from another directory — the container case", async () => {
    const previous = join(dir, "previous-image/dist/client");
    const client = join(dir, "app/dist/client");
    await write(previous, { "assets/Home-v1.js": "v1" });

    await deploy({ from: previous }, client, { "assets/Home-v2.js": "v2" }, new Date());

    expect(await listAssets(client)).toEqual(["Home-v1.js", "Home-v2.js"]);
    expect(await listAssets(previous)).toEqual(["Home-v1.js"]);
  });

  test("a missing previous build is the first deploy, not an error", async () => {
    const client = join(dir, "dist/client");

    const result = await deploy(
      { from: join(dir, "nowhere") },
      client,
      { "assets/a.js": "a" },
      new Date(),
    );

    expect(result).toEqual({ files: 0, releases: 0 });
    expect(await listAssets(client)).toEqual(["a.js"]);
  });

  test("a recorded path outside `assets/` is not copied", async () => {
    const client = join(dir, "dist/client");
    await write(client, {
      "assets/a-v1.js": "1",
      [PREVIOUS_ASSETS_RECORD]: JSON.stringify({
        releases: [{ retiredAt: new Date().toISOString(), files: ["../../secret", "index.html"] }],
      }),
      "index.html": "x",
    });
    await write(dir, { secret: "s" });

    await deploy({ from: client }, client, { "assets/a-v2.js": "2" }, new Date());

    expect(await listAssets(client)).toEqual(["a-v1.js", "a-v2.js"]);
    expect(existsSync(join(client, "index.html"))).toBe(false);
  });
});

describe("what is not carried", () => {
  test("source maps and dotfiles stay behind, even when a record names them", async () => {
    const client = join(dir, "dist/client");
    await write(client, {
      "assets/a-v1.js": "1",
      "assets/a-v1.js.map": "{}",
      "assets/.DS_Store": "x",
      [PREVIOUS_ASSETS_RECORD]: JSON.stringify({
        releases: [{ retiredAt: new Date().toISOString(), files: ["assets/old-v0.js.map"] }],
      }),
      "assets/old-v0.js.map": "{}",
    });

    await deploy({ from: client }, client, { "assets/a-v2.js": "2" }, new Date());

    expect(await listAssets(client)).toEqual(["a-v1.js", "a-v2.js"]);
  });

  test("a symlink, even one the record names, is not followed out of the previous assets", async () => {
    const client = join(dir, "dist/client");
    await write(dir, { secret: "s" });
    await write(client, {
      "assets/a-v1.js": "1",
      [PREVIOUS_ASSETS_RECORD]: JSON.stringify({
        releases: [{ retiredAt: new Date().toISOString(), files: ["assets/link.js"] }],
      }),
    });
    await symlink(join(dir, "secret"), join(client, "assets/link.js"));

    await deploy({ from: client }, client, { "assets/a-v2.js": "2" }, new Date());

    expect(await listAssets(client)).toEqual(["a-v1.js", "a-v2.js"]);
  });

  test("the record stays bounded over many deploys", async () => {
    const client = join(dir, "dist/client");
    await write(client, { "assets/a-0.js": "0" });
    for (let i = 1; i <= 10; i++) {
      await deploy(
        { from: client },
        client,
        { [`assets/a-${i}.js`]: String(i), "assets/vendor.js": "same" },
        new Date(Date.UTC(2026, 9, 1, i)),
      );
    }
    expect(await listAssets(client)).toEqual(["a-10.js", "a-8.js", "a-9.js", "vendor.js"]);
    const record = JSON.parse(await readFile(join(client, PREVIOUS_ASSETS_RECORD), "utf8"));
    expect(record.releases.map((r: { files: string[] }) => r.files)).toEqual([
      ["assets/a-9.js"],
      ["assets/a-8.js"],
    ]);
  });
});

describe("resolvePreviousAssets", () => {
  test("is off unless configured or GEMI_PREVIOUS_ASSETS is set", () => {
    expect(resolvePreviousAssets(undefined, "/app", undefined)).toBeUndefined();
    expect(resolvePreviousAssets(false, "/app", "")).toBeUndefined();
  });

  test("`true` takes the app's own dist/client and the defaults", () => {
    expect(resolvePreviousAssets(true, "/app", undefined)).toEqual({
      from: "/app/dist/client",
      releases: 2,
      maxAgeMs: 7 * DAY,
    });
  });

  test("the variable wins as the source, and is resolved against the app", () => {
    expect(
      resolvePreviousAssets({ from: "/elsewhere", releases: 1 }, "/app", "prev/client"),
    ).toEqual({ from: "/app/prev/client", releases: 1, maxAgeMs: 7 * DAY });
  });

  test("refuses a nonsensical count or age", () => {
    expect(() => resolvePreviousAssets({ releases: -1 }, "/app", undefined)).toThrow();
    expect(() => resolvePreviousAssets({ maxAge: Number.NaN }, "/app", undefined)).toThrow();
  });
});
