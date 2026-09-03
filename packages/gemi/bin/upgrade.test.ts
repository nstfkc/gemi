import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { dependencyKind, detectPackageManager, installCommand, runUpgrade } from "./upgrade";

/**
 * `gemi upgrade`, with the install itself stubbed out.
 *
 * What is being checked is the two decisions the command makes that the package
 * manager cannot: which version it resolves for the channel you are on, and
 * which dependency list it puts gemi back into. The second one is the quiet
 * failure — `bun add gemi@x` defaults to `dependencies`, so a gemi that lived in
 * `devDependencies` gets promoted, and the diff shows up in a review as an
 * unexplained manifest change nobody made.
 */

const dirs: string[] = [];

interface ProjectOptions {
  installed?: string | null;
  manifest?: unknown;
  lockfiles?: string[];
}

function project({ installed = "0.58.0", manifest, lockfiles = [] }: ProjectOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gemi-upgrade-"));
  dirs.push(dir);
  if (installed !== null) {
    const pkg = join(dir, "node_modules", "gemi");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "gemi", version: installed }));
  }
  if (manifest !== undefined) {
    writeFileSync(
      join(dir, "package.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  for (const file of lockfiles) writeFileSync(join(dir, file), "");
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

function harness(overrides: Partial<Parameters<typeof runUpgrade>[0]> = {}) {
  const log = vi.fn();
  const error = vi.fn();
  const spawn = vi.fn(async () => 0);
  return {
    log,
    error,
    spawn,
    options: { log, error, spawn, ...overrides },
    lines: () => log.mock.calls.map((call) => String(call[0])).join("\n"),
    errors: () => error.mock.calls.map((call) => String(call[0])).join("\n"),
  };
}

describe("detectPackageManager", () => {
  test("reads the lockfile", () => {
    expect(detectPackageManager(project({ lockfiles: ["pnpm-lock.yaml"] }))).toBe("pnpm");
    expect(detectPackageManager(project({ lockfiles: ["yarn.lock"] }))).toBe("yarn");
    expect(detectPackageManager(project({ lockfiles: ["package-lock.json"] }))).toBe("npm");
    expect(detectPackageManager(project({ lockfiles: ["bun.lockb"] }))).toBe("bun");
  });

  test("defaults to bun, which is what a gemi project runs on", () => {
    expect(detectPackageManager(project())).toBe("bun");
  });

  test("prefers bun when a repo carries more than one lockfile", () => {
    expect(detectPackageManager(project({ lockfiles: ["bun.lock", "package-lock.json"] }))).toBe(
      "bun",
    );
  });
});

describe("dependencyKind", () => {
  test("finds gemi in dependencies", () => {
    expect(dependencyKind(project({ manifest: { dependencies: { gemi: "^0.58.0" } } }))).toBe(
      "dependencies",
    );
  });

  test("finds gemi in devDependencies", () => {
    expect(dependencyKind(project({ manifest: { devDependencies: { gemi: "^0.58.0" } } }))).toBe(
      "devDependencies",
    );
  });

  test("returns null when gemi is not declared, or the manifest is unreadable", () => {
    expect(dependencyKind(project({ manifest: { dependencies: {} } }))).toBeNull();
    expect(dependencyKind(project({ manifest: "{ not json" }))).toBeNull();
    expect(dependencyKind(project())).toBeNull();
  });
});

describe("installCommand", () => {
  test("uses each manager's own add command", () => {
    expect(installCommand("bun", "gemi@1.0.0", "dependencies")).toEqual([
      "bun",
      "add",
      "gemi@1.0.0",
    ]);
    expect(installCommand("pnpm", "gemi@1.0.0", "dependencies")).toEqual([
      "pnpm",
      "add",
      "gemi@1.0.0",
    ]);
    expect(installCommand("npm", "gemi@1.0.0", "dependencies")).toEqual([
      "npm",
      "install",
      "--save-prod",
      "gemi@1.0.0",
    ]);
  });

  test("keeps a dev-only gemi in devDependencies", () => {
    expect(installCommand("bun", "gemi@1.0.0", "devDependencies")).toEqual([
      "bun",
      "add",
      "--dev",
      "gemi@1.0.0",
    ]);
    expect(installCommand("yarn", "gemi@1.0.0", "devDependencies")).toEqual([
      "yarn",
      "add",
      "--dev",
      "gemi@1.0.0",
    ]);
  });
});

describe("runUpgrade", () => {
  test("resolves the channel's tag and runs the install", async () => {
    const h = harness();
    const fetchImpl = respond({ version: "0.59.0" });
    const rootDir = project({
      installed: "0.58.0",
      manifest: { dependencies: { gemi: "^0.58.0" } },
      lockfiles: ["bun.lock"],
    });

    expect(await runUpgrade({ rootDir, fetchImpl, ...h.options })).toBe(0);
    expect(String((fetchImpl as never as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatch(
      /\/gemi\/latest$/,
    );
    expect(h.spawn).toHaveBeenCalledWith(["bun", "add", "gemi@0.59.0"], rootDir);
    expect(h.lines()).toContain("0.58.0 → 0.59.0");
  });

  test("stays on the rc channel rather than moving back to stable", async () => {
    const h = harness();
    const fetchImpl = respond({ version: "0.60.0-rc.3" });
    const rootDir = project({ installed: "0.60.0-rc.1" });

    expect(await runUpgrade({ rootDir, fetchImpl, ...h.options })).toBe(0);
    expect(String((fetchImpl as never as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatch(
      /\/gemi\/rc$/,
    );
    expect(h.spawn).toHaveBeenCalledWith(["bun", "add", "gemi@0.60.0-rc.3"], rootDir);
  });

  test("an explicit version is used without asking the registry", async () => {
    // This is how you pin, and how you get back after an upgrade goes wrong —
    // it has to work with no network.
    const h = harness();
    const fetchImpl = respond({ version: "9.9.9" });
    const rootDir = project({ installed: "0.59.0" });

    expect(await runUpgrade({ rootDir, target: "0.58.0", fetchImpl, ...h.options })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledWith(["bun", "add", "gemi@0.58.0"], rootDir);
    expect(h.lines()).toContain("Downgrading gemi 0.59.0 → 0.58.0");
  });

  test("an explicit dist-tag is resolved", async () => {
    const h = harness();
    const fetchImpl = respond({ version: "0.60.0-rc.3" });
    const rootDir = project({ installed: "0.59.0" });

    expect(await runUpgrade({ rootDir, target: "rc", fetchImpl, ...h.options })).toBe(0);
    expect(String((fetchImpl as never as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatch(
      /\/gemi\/rc$/,
    );
  });

  test("keeps a dev-only gemi in devDependencies", async () => {
    const h = harness();
    const rootDir = project({
      installed: "0.58.0",
      manifest: { devDependencies: { gemi: "^0.58.0" } },
    });

    await runUpgrade({ rootDir, fetchImpl: respond({ version: "0.59.0" }), ...h.options });
    expect(h.spawn).toHaveBeenCalledWith(["bun", "add", "--dev", "gemi@0.59.0"], rootDir);
  });

  test("says so and installs nothing when already current", async () => {
    const h = harness();
    const rootDir = project({ installed: "0.59.0" });

    expect(
      await runUpgrade({ rootDir, fetchImpl: respond({ version: "0.59.0" }), ...h.options }),
    ).toBe(0);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.lines()).toContain("already the newest release on `latest`");
  });

  test("an explicit version that is already installed names no tag", async () => {
    // "already the latest on `latest`" is only true of a resolved tag; an
    // explicit version has none, and claiming one would be unchecked.
    const h = harness();
    expect(
      await runUpgrade({
        rootDir: project({ installed: "0.59.0" }),
        target: "0.59.0",
        fetchImpl: respond({ version: "9.9.9" }),
        ...h.options,
      }),
    ).toBe(0);
    expect(h.lines()).toBe("gemi is already at 0.59.0.");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("--dry-run prints the command and runs nothing", async () => {
    const h = harness();
    const rootDir = project({ installed: "0.58.0" });

    expect(
      await runUpgrade({
        rootDir,
        dryRun: true,
        fetchImpl: respond({ version: "0.59.0" }),
        ...h.options,
      }),
    ).toBe(0);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.lines()).toContain("Would run: bun add gemi@0.59.0");
  });

  test("points at UPGRADE.md when the minor changes, and not for a patch", async () => {
    const breaking = harness();
    await runUpgrade({
      rootDir: project({ installed: "0.58.0" }),
      fetchImpl: respond({ version: "0.59.0" }),
      ...breaking.options,
    });
    expect(breaking.lines()).toContain("UPGRADE.md");

    const patch = harness();
    await runUpgrade({
      rootDir: project({ installed: "0.59.0" }),
      fetchImpl: respond({ version: "0.59.1" }),
      ...patch.options,
    });
    expect(patch.lines()).not.toContain("UPGRADE.md");
  });

  test("fails with a sentence outside a gemi project", async () => {
    const h = harness();
    expect(
      await runUpgrade({
        rootDir: project({ installed: null }),
        fetchImpl: respond({ version: "0.59.0" }),
        ...h.options,
      }),
    ).toBe(1);
    expect(h.errors()).toContain("Could not find an installed gemi");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("fails with a sentence when the tag cannot be resolved", async () => {
    const h = harness();
    expect(
      await runUpgrade({
        rootDir: project({ installed: "0.58.0" }),
        target: "nope",
        fetchImpl: respond({}, false),
        ...h.options,
      }),
    ).toBe(1);
    expect(h.errors()).toContain("Could not resolve `gemi@nope`");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("refreshes the shipped skill after a successful install", async () => {
    // The skill documents the framework version, so it has to be re-copied from
    // the package that was just installed — otherwise an agent reads the previous
    // release's rules against the new one.
    const installSkillImpl = vi.fn(() => 0);
    const rootDir = project({ installed: "0.58.0" });

    await runUpgrade({
      rootDir,
      fetchImpl: respond({ version: "0.59.0" }),
      ...harness().options,
      installSkillImpl,
    });
    expect(installSkillImpl).toHaveBeenCalledWith(
      expect.objectContaining({ rootDir, onlyIfInstalled: true }),
    );
  });

  test("does not refresh the skill on --dry-run", async () => {
    const installSkillImpl = vi.fn(() => 0);
    await runUpgrade({
      rootDir: project({ installed: "0.58.0" }),
      dryRun: true,
      fetchImpl: respond({ version: "0.59.0" }),
      ...harness().options,
      installSkillImpl,
    });
    expect(installSkillImpl).not.toHaveBeenCalled();
  });

  test("does not refresh the skill when the install failed", async () => {
    const installSkillImpl = vi.fn(() => 0);
    await runUpgrade({
      rootDir: project({ installed: "0.58.0" }),
      fetchImpl: respond({ version: "0.59.0" }),
      ...harness({ spawn: vi.fn(async () => 1) }).options,
      installSkillImpl,
    });
    expect(installSkillImpl).not.toHaveBeenCalled();
  });

  test("a declined skill copy does not fail the upgrade", async () => {
    // The package upgrade succeeded. A skill that needs --force is a note.
    const h = harness();
    expect(
      await runUpgrade({
        rootDir: project({ installed: "0.58.0" }),
        fetchImpl: respond({ version: "0.59.0" }),
        ...h.options,
        installSkillImpl: vi.fn(() => 1),
      }),
    ).toBe(0);
  });

  test("propagates the package manager's exit code", async () => {
    const h = harness({ spawn: vi.fn(async () => 7) });
    expect(
      await runUpgrade({
        rootDir: project({ installed: "0.58.0" }),
        fetchImpl: respond({ version: "0.59.0" }),
        ...h.options,
      }),
    ).toBe(7);
    expect(h.errors()).toContain("exit code 7");
  });
});
