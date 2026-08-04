import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import * as orm from "../orm/index";
import { user } from "../orm/fixtures";
import type { ModelPolicy } from "../orm/policy";
import {
  auditModules,
  modelFiles,
  printReport,
  snapshotRegistry,
} from "./check-models";

/**
 * `gemi check models` — the file-walking half of #318.
 *
 * The rule it applies is `auditModelRegistrations`, tested against every shape
 * in `orm/registration.test.ts`. What is this file's own is everything around
 * it: which files are offered to the rule, which of its answers are findings,
 * and whether a `register` call that ran while a file was being imported is
 * allowed to answer for that file.
 *
 * The last one is the point of the whole command. A class that owns its name
 * only because loading its module said so is a class whose registration
 * disappears the day nothing imports the module — which is exactly the failure
 * being checked for, so crediting it would make the check agree with the bug.
 */

const scope: ModelPolicy = { scope: () => ({ organizationId: 7 }) };
const narrow: ModelPolicy = { scope: () => ({ archived: false }) };

class UserBase {
  static $schema = user;
  static $generated = true;
}

/** A module record, as `import * as ns` produces one. */
const module = (exports: Record<string, unknown>) => ({
  path: "/app/models/x.ts",
  label: "app/models/x.ts",
  module: exports,
});

afterEach(() => {
  orm.registry.clearRegistry();
});

describe("which files are offered to the rule", () => {
  const roots: string[] = [];

  const tree = (files: string[]): string => {
    const root = mkdtempSync(join(tmpdir(), "gemi-check-models-"));
    roots.push(root);
    for (const file of files) {
      const path = join(root, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "");
    }
    return root;
  };

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("walks nested directories, because apps group models into folders", () => {
    const root = tree(["index.ts", "billing/Invoice.ts", "billing/Plan.ts"]);

    expect(modelFiles(root).map((path) => path.slice(root.length + 1))).toEqual([
      "billing/Invoice.ts",
      "billing/Plan.ts",
      "index.ts",
    ]);
  });

  /**
   * Tests and benchmarks are the files certain not to be a model module and
   * most likely to be expensive to import — the template's own `app/models` has
   * thirty of them, several of which load a Prisma client.
   */
  test("skips tests, type tests and benchmarks", () => {
    const root = tree([
      "User.ts",
      "User.test.ts",
      "select.test-d.ts",
      "reads.bench.ts",
      "notes.spec.ts",
    ]);

    expect(modelFiles(root).map((path) => path.slice(root.length + 1))).toEqual([
      "User.ts",
    ]);
  });

  test("skips node_modules and dot-directories", () => {
    const root = tree([
      "User.ts",
      "node_modules/pkg/index.ts",
      ".cache/thing.ts",
    ]);

    expect(modelFiles(root).map((path) => path.slice(root.length + 1))).toEqual([
      "User.ts",
    ]);
  });

  /**
   * `generated/` is walked like anything else. Its classes are registered by
   * the declared modules, so they produce no findings — and skipping a
   * directory by name would be one more guess about generator output, which is
   * the habit #318's other half removes.
   */
  test("does not special-case the generated directory", () => {
    const root = tree(["index.ts", "generated/models.ts"]);

    expect(modelFiles(root).map((path) => path.slice(root.length + 1))).toEqual([
      "generated/models.ts",
      "index.ts",
    ]);
  });

  test("ignores files that are not TypeScript", () => {
    const root = tree(["User.ts", "schema.prisma", "notes.md", "dev.db"]);

    expect(modelFiles(root).map((path) => path.slice(root.length + 1))).toEqual([
      "User.ts",
    ]);
  });

  /** `.d.ts` ends in `.ts` and has no runtime module behind it. */
  test("skips declaration files", () => {
    const root = tree(["User.ts", "client/index.d.ts"]);

    expect(modelFiles(root).map((path) => path.slice(root.length + 1))).toEqual([
      "User.ts",
    ]);
  });

  /**
   * A directory with a `package.json` is a package that happens to live here —
   * a vendored client, a generated SDK — and importing its entry point runs
   * somebody else's module graph. The template has two under `app/models`, both
   * gitignored Prisma clients.
   */
  test("skips a vendored package", () => {
    const root = tree([
      "User.ts",
      "prisma-client/package.json",
      "prisma-client/index.ts",
    ]);

    expect(modelFiles(root).map((path) => path.slice(root.length + 1))).toEqual([
      "User.ts",
    ]);
  });

  test("--ignore skips a path and everything under it", () => {
    const root = tree(["User.ts", "bench/run.ts", "bench/harness.ts"]);

    expect(
      modelFiles(root, ["bench"]).map((path) => path.slice(root.length + 1)),
    ).toEqual(["User.ts"]);
  });

  test("--ignore can name a single file", () => {
    const root = tree(["User.ts", "bench/run.ts", "bench/harness.ts"]);

    expect(
      modelFiles(root, ["bench/run.ts"]).map((path) =>
        path.slice(root.length + 1),
      ),
    ).toEqual(["User.ts", "bench/harness.ts"].sort());
  });
});

describe("what counts as a finding", () => {
  /**
   * #318's case A, in full: the class is written, the policy is written, and
   * the barrel does not re-export it — so the Kernel registers the generated
   * base and every nested read of the model comes back unscoped.
   */
  test("a policied class the declared modules never saw", () => {
    class Membership extends UserBase {
      static $policies = [scope];
    }

    orm.registerModels({ UserBase });

    const findings = auditModules(orm, [module({ Membership })], snapshotRegistry(orm));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe("app/models/x.ts");
    expect(findings[0]!.message).toContain("Membership");
  });

  test("a class the declared modules do register is not a finding", () => {
    class User extends UserBase {
      static $policies = [scope];
    }

    orm.registerModels({ UserBase }, { User });

    expect(auditModules(orm, [module({ User })], snapshotRegistry(orm))).toEqual([]);
  });

  /**
   * **The view that must not be reported.** `registerModels` refuses a policied
   * view *because* registering it would apply its narrowing to every nested
   * read, and the error tells the author to keep it out of `Kernel.models` and
   * query it directly. Being absent from the declared modules is what following
   * that advice looks like.
   */
  test("a policied view kept out of the declared modules is not a finding", () => {
    class User extends UserBase {
      static $policies = [scope];
    }
    class AdminUser extends User {
      static $policies = [narrow];
    }

    orm.registerModels({ UserBase }, { User });

    expect(auditModules(orm, [module({ AdminUser })], snapshotRegistry(orm))).toEqual([]);
  });

  test("an unpolicied class the barrel does not export is not a finding", () => {
    class Typed extends UserBase {}

    orm.registerModels({ UserBase });

    expect(auditModules(orm, [module({ Typed })], snapshotRegistry(orm))).toEqual([]);
  });

  test("non-model exports are ignored", () => {
    orm.registerModels({ UserBase });

    expect(
      auditModules(orm, [
        module({ PAGE_SIZE: 20, helper: () => null, nothing: undefined }),
      ], snapshotRegistry(orm)),
    ).toEqual([]);
  });

  test("every file is reported, not just the first", () => {
    class Membership extends UserBase {
      static $policies = [scope];
    }
    class Invoice extends UserBase {
      static $policies = [narrow];
    }

    orm.registerModels({ UserBase });

    const findings = auditModules(orm, [
      { path: "/a.ts", label: "app/models/Membership.ts", module: { Membership } },
      { path: "/b.ts", label: "app/models/Invoice.ts", module: { Invoice } },
    ], snapshotRegistry(orm));

    expect(findings.map((finding) => finding.file)).toEqual([
      "app/models/Membership.ts",
      "app/models/Invoice.ts",
    ]);
  });
});

/**
 * The reason the check restores the registry between files.
 *
 * Importing a module runs it, and a model file written the pre-0.51 way ends in
 * `register("User", User)`. That call makes the class own its name for the rest
 * of the process — including for the audit that is about to ask whether it owns
 * its name. The answer would be yes, for every file, and the check would report
 * nothing on an app where nothing imports any of them.
 */
describe("a register call that ran while the file was importing", () => {
  test("does not answer for the file that made it", () => {
    class Membership extends UserBase {
      static $policies = [scope];
    }

    orm.registerModels({ UserBase });

    // The command's own ordering: the baseline is taken while the registry is
    // still what the declared modules made it, and every file is imported
    // after.
    const baseline = snapshotRegistry(orm);

    // What `await import("./Membership")` does, on a model file written the
    // pre-0.51 way.
    orm.register("User", Membership);

    expect(
      auditModules(orm, [module({ Membership })], baseline),
    ).toHaveLength(1);
  });

  /** And the registry is left as the declared modules made it. */
  test("and is undone before the command returns", () => {
    class Membership extends UserBase {
      static $policies = [scope];
    }

    orm.registerModels({ UserBase });
    const baseline = snapshotRegistry(orm);
    orm.register("User", Membership);

    auditModules(orm, [module({ Membership })], baseline);

    expect(orm.registry.get("User")).toBe(UserBase);
  });
});

describe("the printed report", () => {
  const lines = (report: Parameters<typeof printReport>[0]) => {
    const out: string[] = [];
    const code = printReport(report, (line: string) => out.push(line));
    return { code, text: out.join("\n") };
  };

  test("a clean run says what it covered and exits zero", () => {
    const { code, text } = lines({
      files: ["app/models/index.ts", "app/models/User.ts"],
      registered: 13,
      ignored: [],
      findings: [],
    });

    expect(code).toBe(0);
    expect(text).toContain("2 model files");
    expect(text).toContain("13 registered models");
  });

  test("a finding is printed under its file and exits non-zero", () => {
    const { code, text } = lines({
      files: ["app/models/Membership.ts"],
      registered: 13,
      ignored: [],
      findings: [
        {
          file: "app/models/Membership.ts",
          className: "Membership",
          message: "Membership carries\npolicies",
        },
      ],
    });

    expect(code).toBe(1);
    expect(text).toContain("app/models/Membership.ts");
    // Indented under the filename, and the indent survives a multi-line message.
    expect(text).toContain("    Membership carries\n    policies");
    expect(text).toContain("Kernel.models");
  });

  /**
   * The error's own advice is `register("Membership", Membership)`, which is a
   * correct fix and the wrong one to lead with here: the class was found by
   * walking a directory, so what went missing is the export, and a hand-written
   * `register` line puts the app back on the mechanism 0.51 replaced.
   */
  test("names the export that was missing, spelled for the file it was in", () => {
    const { text } = lines({
      files: ["app/models/ScopedMembership.ts"],
      registered: 13,
      ignored: [],
      findings: [
        {
          file: "app/models/ScopedMembership.ts",
          className: "Membership",
          message: "…",
        },
      ],
    });

    expect(text).toContain(
      'export { Membership } from "./ScopedMembership"',
    );
  });

  /** A run that covered less than the directory has to say so. */
  test("says what it was told to skip", () => {
    const { text } = lines({
      files: ["app/models/User.ts"],
      registered: 13,
      ignored: ["bench", "vendor"],
      findings: [],
    });

    expect(text).toContain("Ignoring bench, vendor.");
  });

  test("counts read as English in both directions", () => {
    expect(
      lines({
        files: ["a.ts"],
        registered: 1,
        ignored: [],
        findings: [{ file: "a.ts", className: "A", message: "x" }],
      }).text,
    ).toContain("1 model class is not registered");

    expect(
      lines({
        files: ["a.ts"],
        registered: 1,
        ignored: [],
        findings: [
          { file: "a.ts", className: "A", message: "x" },
          { file: "b.ts", className: "B", message: "y" },
        ],
      }).text,
    ).toContain("2 model classes are not registered");
  });
});
