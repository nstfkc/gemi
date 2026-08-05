import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import * as orm from "../orm/index";
import { user } from "../orm/fixtures";
import type { ModelPolicy } from "../orm/policy";
import {
  CheckModelsError,
  auditModules,
  checkModels,
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
  label: "app/models/x.ts",
  specifier: "./x",
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

  /**
   * **The other answer that must not be reported**, and the one that is easy to
   * miss because it does not look like a subclass at all.
   *
   * `asModelClass` asks for a `$schema` with a name and nothing more, so a class
   * written against a model's schema without extending its base — a reporting
   * projection, a read-side view — is a candidate for that name while sitting
   * outside its prototype chain. Unpolicied, it comes back as
   * `carries: "registered"`.
   *
   * Reporting it would contradict the rule above *and* print the wrong fix:
   * exporting it from the barrel puts two unrelated classes claiming one model
   * in the modules the Kernel is handed, which is `AmbiguousModelRegistrationError`
   * and a boot that stops. Keeping it out is what that error asks for.
   */
  test("an unpolicied class claiming a policied model's name is not a finding", () => {
    class User extends UserBase {
      static $policies = [scope];
    }
    class UserSnapshot {
      static $schema = user;
    }

    orm.registerModels({ UserBase }, { User });

    expect(
      auditModules(orm, [module({ UserSnapshot })], snapshotRegistry(orm)),
    ).toEqual([]);
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
      {
        label: "app/models/Membership.ts",
        specifier: "./Membership",
        module: { Membership },
      },
      {
        label: "app/models/Invoice.ts",
        specifier: "./Invoice",
        module: { Invoice },
      },
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

/**
 * `checkModels` itself, over a project on disk.
 *
 * Everything above enters below the entry point, with module objects handed
 * straight to the rule. That leaves the parts that only exist outside a test
 * uncovered — loading the Kernel and reading `models` off it, walking and
 * importing real files, and the ordering that decides which registry each file
 * is judged against — and those are precisely where this command's failure mode
 * lives. A regression in any of them prints *Every policied class owns its
 * name*, exits 0, and CI stays green: a checker that reports nothing looks
 * exactly like a project with nothing to report.
 *
 * So the assertion that matters is the red path, on the real function.
 *
 * The fixture imports nothing from `gemi` — a class needs a `$schema` with a
 * name and a `$policies` array to be everything the audit reads, and the Kernel
 * only has to be a default-exported constructor with a `models` field. That is
 * what lets it live in a temp directory with no `node_modules` above it, and
 * why `orm` is injected: resolving `gemi/orm` from the project is right for the
 * command and impossible for a fixture.
 */
describe("the command, over a project on disk", () => {
  const roots: string[] = [];

  const write = (root: string, path: string, source: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  };

  /**
   * One generated base, one policied subclass the barrel exports, and one
   * policied subclass in a subdirectory that it does not — which is #318's
   * case A, in the layout that makes the printed fix worth getting right.
   */
  const project = (): string => {
    const root = mkdtempSync(join(tmpdir(), "gemi-check-project-"));
    roots.push(root);

    write(
      root,
      "app/models/generated/index.ts",
      `export class WidgetModel {
         static $schema = { name: "Widget" };
         static $generated = true;
       }
       export class GadgetModel {
         static $schema = { name: "Gadget" };
         static $generated = true;
       }`,
    );

    write(
      root,
      "app/models/Widget.ts",
      `import { WidgetModel } from "./generated";
       export class Widget extends WidgetModel {
         static $policies = [{ scope: () => ({ organizationId: 7 }) }];
       }`,
    );

    // The one nobody exported.
    write(
      root,
      "app/models/billing/Gadget.ts",
      `import { GadgetModel } from "./../generated";
       export class Gadget extends GadgetModel {
         static $policies = [{ scope: () => ({ organizationId: 7 }) }];
       }`,
    );

    write(root, "app/models/index.ts", `export { Widget } from "./Widget";`);

    write(
      root,
      "app/kernel/Kernel.ts",
      `import * as generated from "../models/generated";
       import * as models from "../models";
       export default class {
         models = [generated, models];
       }`,
    );

    return root;
  };

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("reports the policied class the barrel forgot, and only that one", async () => {
    const report = await checkModels({ rootDir: project(), orm });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.file).toBe("app/models/billing/Gadget.ts");
    expect(report.findings[0]!.className).toBe("Gadget");
    // Spelled for a barrel at `app/models/index.ts`, which is the only place it
    // is any use.
    expect(report.findings[0]!.specifier).toBe("./billing/Gadget");
  });

  /**
   * And the green path, on the same project — because a checker that reports
   * everything is as useless as one that reports nothing, and `Widget` is the
   * class that is arranged correctly.
   */
  test("says nothing about the class the barrel does export", async () => {
    const report = await checkModels({ rootDir: project(), orm });

    expect(report.files).toContain("app/models/Widget.ts");
    expect(report.findings.map((finding) => finding.className)).not.toContain(
      "Widget",
    );
    // The registry it judged against is the declared one, not an empty one —
    // the failure that would make every other assertion here vacuous.
    expect(report.registered).toBe(2);
  });

  test("--ignore keeps a directory out, and the report says so", async () => {
    const report = await checkModels({
      rootDir: project(),
      ignore: ["billing"],
      orm,
    });

    expect(report.findings).toEqual([]);
    expect(report.ignored).toEqual(["billing"]);
    expect(report.files.join()).not.toContain("billing");
  });

  /**
   * The state an app upgrading from 0.48 is in. There is no declared
   * arrangement to compare files against, so the command says that rather than
   * comparing them against an empty registry and reporting every model.
   */
  test("an empty Kernel.models is refused, with the fix", async () => {
    const root = project();
    write(root, "app/kernel/Kernel.ts", `export default class {};`);

    await expect(checkModels({ rootDir: root, orm })).rejects.toThrow(
      /Kernel\.models` is empty/,
    );
  });

  /**
   * `--models`, and the reason it exists: reading the list off the Kernel means
   * importing the Kernel, and a gemi app's import graph does not have to be
   * resolvable by a bare `await import()`. The app that reported #316 and #318
   * transitively reaches a `.md?raw` import from its Kernel, so the command
   * could not run on the project it was written for.
   *
   * The fixture reproduces that shape with an import nothing can resolve.
   */
  test("names the model modules directly, for a Kernel that will not import", async () => {
    const root = project();
    write(
      root,
      "app/kernel/Kernel.ts",
      `import doc from "./guide.md?raw";
       import * as generated from "../models/generated";
       import * as models from "../models";
       export default class {
         models = [generated, models];
         doc = doc;
       }`,
    );

    // The Kernel path fails, loudly, naming the file rather than passing green.
    await expect(checkModels({ rootDir: root, orm })).rejects.toThrow(
      /Could not load app\/kernel\/Kernel\.ts/,
    );

    // And the flag gets the same answer without going near it.
    const report = await checkModels({
      rootDir: root,
      models: ["app/models/generated", "app/models"],
      orm,
    });

    expect(report.registered).toBe(2);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.className).toBe("Gadget");
  });

  test("--models is checked in the order given, so a later module wins", async () => {
    const report = await checkModels({
      rootDir: project(),
      models: ["app/models/generated", "app/models"],
      orm,
    });

    // The barrel's subclass took the name from the base it extends, which is
    // what "later wins" means and what makes `Widget` not a finding.
    expect(
      (orm.registry.get("Widget") as { name: string }).name,
    ).toBe("Widget");
    expect(report.findings.map((finding) => finding.className)).toEqual([
      "Gadget",
    ]);
  });

  test("a path --models names that cannot be imported says which", async () => {
    await expect(
      checkModels({
        rootDir: project(),
        models: ["app/models/nope"],
        orm,
      }),
    ).rejects.toThrow(/--models named app\/models\/nope/);
  });

  test("a project with no Kernel is refused by name", async () => {
    const root = mkdtempSync(join(tmpdir(), "gemi-check-empty-"));
    roots.push(root);
    mkdirSync(join(root, "app/models"), { recursive: true });

    await expect(checkModels({ rootDir: root, orm })).rejects.toThrow(
      CheckModelsError,
    );
  });

  /**
   * With no `orm` injected there is nothing to resolve from a temp directory,
   * which is the one branch a fixture cannot exercise from the inside. Its
   * failure side is worth pinning anyway: run outside a project, the command
   * should say so rather than throw a resolver's stack.
   */
  test("outside a gemi project it says so", async () => {
    const root = mkdtempSync(join(tmpdir(), "gemi-check-bare-"));
    roots.push(root);
    mkdirSync(join(root, "app/models"), { recursive: true });

    await expect(checkModels({ rootDir: root })).rejects.toThrow(
      /Could not resolve `gemi\/orm`/,
    );
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
          specifier: "./Membership",
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
   *
   * **Spelled from the models directory, not from the project root and not from
   * the basename.** A model in a subdirectory is the case the walker is built
   * for, and `./ScopedMembership` pasted into `app/models/index.ts` resolves to
   * nothing — an author who follows the advice trades a silent leak for a
   * module-not-found.
   */
  test("names the export that was missing, spelled for a barrel to import", () => {
    const { text } = lines({
      files: ["app/models/billing/ScopedMembership.ts"],
      registered: 13,
      ignored: [],
      findings: [
        {
          file: "app/models/billing/ScopedMembership.ts",
          specifier: "./billing/ScopedMembership",
          className: "Membership",
          message: "…",
        },
      ],
    });

    expect(text).toContain(
      'export { Membership } from "./billing/ScopedMembership"',
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
        findings: [
          { file: "a.ts", specifier: "./a", className: "A", message: "x" },
        ],
      }).text,
    ).toContain("1 model class is not registered");

    expect(
      lines({
        files: ["a.ts"],
        registered: 1,
        ignored: [],
        findings: [
          { file: "a.ts", specifier: "./a", className: "A", message: "x" },
          { file: "b.ts", specifier: "./b", className: "B", message: "y" },
        ],
      }).text,
    ).toContain("2 model classes are not registered");
  });
});
