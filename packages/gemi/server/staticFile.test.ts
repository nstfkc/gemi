import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { listPublicFiles } from "./staticFile";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemi-public-files-"));
  await mkdir(join(dir, "assets/nested"), { recursive: true });
  await mkdir(join(dir, ".vite"), { recursive: true });
  await mkdir(join(dir, "v2/video"), { recursive: true });
  await mkdir(join(dir, "docs/assets"), { recursive: true });
  await writeFile(join(dir, "assets/app.js"), "");
  await writeFile(join(dir, "assets/nested/x.png"), "");
  await writeFile(join(dir, ".vite/manifest.json"), "{}");
  await writeFile(join(dir, ".DS_Store"), "");
  await writeFile(join(dir, "favicon.ico"), "");
  await writeFile(join(dir, "v2/video/clip.mp4"), "");
  await writeFile(join(dir, "v2/video/.env"), "");
  await writeFile(join(dir, "docs/assets/guide.pdf"), "");
  await symlink(join(dir, "favicon.ico"), join(dir, "linked.ico"));
  // A directory link back up the tree: following it would never end.
  await symlink(dir, join(dir, "loop"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listPublicFiles", () => {
  test("lists every file outside /assets and dot-names, at any depth", async () => {
    const files = await listPublicFiles(dir);

    expect([...files].map((f) => f.slice(dir.length)).sort()).toEqual([
      "/docs/assets/guide.pdf",
      "/favicon.ico",
      "/linked.ico",
      "/v2/video/clip.mp4",
    ]);
  });

  test("is empty for a missing directory", async () => {
    expect((await listPublicFiles(join(dir, "nope"))).size).toBe(0);
  });
});
