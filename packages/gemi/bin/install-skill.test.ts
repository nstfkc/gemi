import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SKILL_NAME,
  hashDirectory,
  installSkill,
  isSkillInstalled,
  readLock,
} from "./install-skill";

/**
 * `gemi install-skill`, and the two things it must never do.
 *
 * It must not silently discard an edited copy — an agent skill is exactly the
 * kind of file a team tunes in place, and a command that runs automatically from
 * `gemi upgrade` would otherwise eat those edits on a Tuesday with no prompt.
 *
 * And it must not leave a rule behind when one is deleted upstream. A copy that
 * merges rather than replaces keeps serving a rule the framework has retracted,
 * which is worse than not shipping the skill at all: the agent reads it as
 * current.
 */

const dirs: string[] = [];

interface Fixture {
  rootDir: string;
  /** Rewrite the skill as it ships inside node_modules/gemi. */
  publish: (files: Record<string, string>) => void;
  /** Read a file from the installed copy. */
  installed: (relative: string) => string;
}

function fixture({
  version = "0.59.0",
  files = { "SKILL.md": "# v1\n", "rules/a.md": "a\n" },
} = {}): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), "gemi-skill-"));
  dirs.push(rootDir);
  const pkg = join(rootDir, "node_modules", "gemi");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "gemi", version }));

  const publish = (next: Record<string, string>) => {
    rmSync(join(pkg, "skills"), { recursive: true, force: true });
    for (const [relative, content] of Object.entries(next)) {
      const full = join(pkg, "skills", SKILL_NAME, relative);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  };
  publish(files);

  return {
    rootDir,
    publish,
    installed: (relative) =>
      readFileSync(join(rootDir, ".agents", "skills", SKILL_NAME, relative), "utf8"),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const log = vi.fn();
  const error = vi.fn();
  return {
    log,
    error,
    options: { log, error },
    lines: () => log.mock.calls.map((call) => String(call[0])).join("\n"),
    errors: () => error.mock.calls.map((call) => String(call[0])).join("\n"),
  };
}

describe("hashDirectory", () => {
  test("changes when a file's contents change", () => {
    const a = fixture();
    const before = hashDirectory(join(a.rootDir, "node_modules", "gemi", "skills", SKILL_NAME));
    a.publish({ "SKILL.md": "# v2\n", "rules/a.md": "a\n" });
    const after = hashDirectory(join(a.rootDir, "node_modules", "gemi", "skills", SKILL_NAME));
    expect(after).not.toBe(before);
  });

  test("changes when a file is renamed, contents unchanged", () => {
    // Paths are in the digest for exactly this: a rule rename is a rename, and a
    // hash over concatenated contents alone would call it identical.
    const a = fixture({ files: { "SKILL.md": "s\n", "rules/old.md": "body\n" } });
    const dir = join(a.rootDir, "node_modules", "gemi", "skills", SKILL_NAME);
    const before = hashDirectory(dir);
    a.publish({ "SKILL.md": "s\n", "rules/new.md": "body\n" });
    expect(hashDirectory(dir)).not.toBe(before);
  });

  test("is stable across calls", () => {
    const a = fixture();
    const dir = join(a.rootDir, "node_modules", "gemi", "skills", SKILL_NAME);
    expect(hashDirectory(dir)).toBe(hashDirectory(dir));
  });
});

describe("installSkill", () => {
  test("copies the skill and records it in the lock", () => {
    const a = fixture();
    const h = harness();

    expect(installSkill({ rootDir: a.rootDir, ...h.options })).toBe(0);
    expect(a.installed("SKILL.md")).toBe("# v1\n");
    expect(a.installed("rules/a.md")).toBe("a\n");
    expect(h.lines()).toContain(".agents/skills/gemi-react-best-practices");
    expect(h.lines()).toContain("gemi 0.59.0");

    const entry = readLock(a.rootDir).skills[SKILL_NAME]!;
    expect(entry.source).toBe("gemi");
    expect(entry.sourceType).toBe("npm");
    expect(entry.version).toBe("0.59.0");
    expect(entry.installedAt).toBeTruthy();
  });

  test("is idempotent, and says so rather than rewriting", () => {
    const a = fixture();
    installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });
    const h = harness();

    expect(installSkill({ rootDir: a.rootDir, ...h.options })).toBe(0);
    expect(h.lines()).toContain("already up to date");
  });

  test("updates in place when the shipped skill changes", () => {
    const a = fixture();
    installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });

    a.publish({ "SKILL.md": "# v2\n", "rules/a.md": "a\n" });
    const h = harness();
    expect(installSkill({ rootDir: a.rootDir, ...h.options })).toBe(0);
    expect(a.installed("SKILL.md")).toBe("# v2\n");
    expect(h.lines()).toContain("Updated");
  });

  test("removes a rule that was deleted upstream", () => {
    // The copy is replaced, not merged. A retracted rule that survives locally is
    // read by an agent as current guidance.
    const a = fixture({
      files: { "SKILL.md": "s\n", "rules/a.md": "a\n", "rules/gone.md": "x\n" },
    });
    installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });
    expect(a.installed("rules/gone.md")).toBe("x\n");

    a.publish({ "SKILL.md": "s\n", "rules/a.md": "a\n" });
    installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });
    expect(() => a.installed("rules/gone.md")).toThrow();
    expect(a.installed("rules/a.md")).toBe("a\n");
  });

  test("refuses to discard local edits", () => {
    const a = fixture();
    installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });
    writeFileSync(
      join(a.rootDir, ".agents", "skills", SKILL_NAME, "rules/a.md"),
      "locally tuned\n",
    );
    a.publish({ "SKILL.md": "# v2\n", "rules/a.md": "a\n" });

    const h = harness();
    expect(installSkill({ rootDir: a.rootDir, ...h.options })).toBe(1);
    expect(h.errors()).toContain("has local edits");
    expect(a.installed("rules/a.md")).toBe("locally tuned\n");
  });

  test("--force discards them", () => {
    const a = fixture();
    installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });
    writeFileSync(join(a.rootDir, ".agents", "skills", SKILL_NAME, "rules/a.md"), "edited\n");

    expect(installSkill({ rootDir: a.rootDir, force: true, log: () => {}, error: () => {} })).toBe(
      0,
    );
    expect(a.installed("rules/a.md")).toBe("a\n");
  });

  test("refuses a directory it did not write", () => {
    // No lock entry beside an existing directory means something else put it
    // there — another skill tool, or a hand-copied folder.
    const a = fixture();
    const target = join(a.rootDir, ".agents", "skills", SKILL_NAME);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "hand written\n");

    const h = harness();
    expect(installSkill({ rootDir: a.rootDir, ...h.options })).toBe(1);
    expect(h.errors()).toContain("was not installed by");
    expect(a.installed("SKILL.md")).toBe("hand written\n");
  });

  test("preserves unrelated keys and other skills in the lock", () => {
    // The lockfile is shared with other skill tooling, which keeps its own state
    // in it. Clobbering that would uninstall someone else's skill.
    const a = fixture();
    mkdirSync(join(a.rootDir, ".agents"), { recursive: true });
    writeFileSync(
      join(a.rootDir, ".agents", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: { "find-skills": { source: "vercel-labs/skills" } },
        dismissed: { findSkillsPrompt: true },
      }),
    );

    installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });
    const lock = readLock(a.rootDir);
    expect(lock.skills["find-skills"]).toEqual({ source: "vercel-labs/skills" });
    expect(lock.skills[SKILL_NAME]).toBeTruthy();
    expect(lock.dismissed).toEqual({ findSkillsPrompt: true });
  });

  test("a damaged lock does not block an install", () => {
    const a = fixture();
    mkdirSync(join(a.rootDir, ".agents"), { recursive: true });
    writeFileSync(join(a.rootDir, ".agents", ".skill-lock.json"), "{ not json");

    expect(installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} })).toBe(0);
    expect(a.installed("SKILL.md")).toBe("# v1\n");
  });

  test("keeps the original installedAt across an update", () => {
    const a = fixture();
    installSkill({
      rootDir: a.rootDir,
      now: () => "2020-01-01T00:00:00.000Z",
      log: () => {},
      error: () => {},
    });
    a.publish({ "SKILL.md": "# v2\n" });
    installSkill({
      rootDir: a.rootDir,
      now: () => "2021-01-01T00:00:00.000Z",
      log: () => {},
      error: () => {},
    });

    const entry = readLock(a.rootDir).skills[SKILL_NAME]!;
    expect(entry.installedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(entry.updatedAt).toBe("2021-01-01T00:00:00.000Z");
  });

  test("fails with a sentence outside a gemi project", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "gemi-skill-"));
    dirs.push(rootDir);
    const h = harness();
    expect(installSkill({ rootDir, ...h.options })).toBe(1);
    expect(h.errors()).toContain("Could not find an installed gemi");
  });

  test("fails with a sentence when the installed gemi ships no skill", () => {
    // An older gemi, upgraded to from a version that had the command.
    const a = fixture();
    rmSync(join(a.rootDir, "node_modules", "gemi", "skills"), { recursive: true, force: true });
    const h = harness();
    expect(installSkill({ rootDir: a.rootDir, ...h.options })).toBe(1);
    expect(h.errors()).toContain("does not ship");
  });

  describe("onlyIfInstalled — how `gemi upgrade` calls it", () => {
    test("does nothing, silently, when the skill is not installed", () => {
      const a = fixture();
      const h = harness();
      expect(installSkill({ rootDir: a.rootDir, onlyIfInstalled: true, ...h.options })).toBe(0);
      expect(isSkillInstalled(a.rootDir)).toBe(false);
      expect(h.lines()).toBe("");
      expect(h.errors()).toBe("");
    });

    test("refreshes it when it is", () => {
      const a = fixture();
      installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });
      a.publish({ "SKILL.md": "# v2\n", "rules/a.md": "a\n" });

      expect(
        installSkill({ rootDir: a.rootDir, onlyIfInstalled: true, log: () => {}, error: () => {} }),
      ).toBe(0);
      expect(a.installed("SKILL.md")).toBe("# v2\n");
    });
  });
});

describe("isSkillInstalled", () => {
  test("is false before an install and true after", () => {
    const a = fixture();
    expect(isSkillInstalled(a.rootDir)).toBe(false);
    installSkill({ rootDir: a.rootDir, log: () => {}, error: () => {} });
    expect(isSkillInstalled(a.rootDir)).toBe(true);
  });
});
