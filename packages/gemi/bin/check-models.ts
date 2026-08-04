import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import type { UnregisteredPolicyClassError } from "../orm/errors";

/**
 * `gemi check models` — the last silent version of #316, closed where the cost
 * of closing it is nobody's request.
 *
 * ### What is left after `Kernel.models`
 *
 * `registerModels` registers every model class in the modules it is handed and
 * audits the result, so a policied subclass no longer needs a `register` line
 * beside it. The mistake it removed has a smaller cousin one level up (#318):
 * instead of forgetting `register("Membership", Membership)`, you forget
 *
 *     export { Membership } from "./Membership"
 *
 * in `app/models/index.ts`. The class is written, its policy is written, and the
 * Kernel is never handed the module it lives in — so the generated base keeps
 * the name, every nested `include` of that model comes back unscoped, and
 * nothing raises. The audit cannot report a class it was never given, and
 * `Model.$exec`'s guard needs a root query that a model read only through
 * includes never gets.
 *
 * ### Why a command rather than a boot step
 *
 * The only way to find a class nobody imported is to enumerate the filesystem,
 * and doing that at boot buys a real cost: bundler coupling, a dev/prod
 * divergence, and a directory walk plus an import of every model file that every
 * production process pays for on every start, for a mistake that can only be
 * made while editing.
 *
 * A check somebody runs pays none of it. This is the same rule
 * `registerModels` applies — `auditModelRegistrations`, unchanged — with the
 * class list coming from `app/models/**` instead of from the Kernel. It runs in
 * CI, it costs production nothing, and it needs no cooperation from a bundler.
 *
 * ### What it deliberately does not do
 *
 * **It does not credit an import-time `register` call.** A file that registers
 * itself is correct only for as long as something imports it, and "something
 * imports it" is the property that just went missing. So the registry is put
 * back to what the Kernel's declared modules made it before each file is
 * audited, and a class that owns its name only because loading its module said
 * so is reported like any other. The fix printed for it — declare the module —
 * is the one that survives a tree-shake.
 *
 * **It does not report a policied view.** `AdminUser extends User` carrying its
 * own narrowing is refused by `registerModels` precisely so that its scope does
 * not silently reach every nested read of `User`, and the error for that case
 * tells the author to keep it out of `Kernel.models` and query it directly. A
 * checker that then demanded it be exported from the barrel would be telling
 * them to undo it. `carries === "narrowing"` is the discriminator.
 *
 * **It does not report an unpolicied class.** One missing from the declared
 * modules is a real if smaller problem — its statics and row methods do not run
 * inside a nested read — but it is indistinguishable from a typed view somebody
 * meant to keep local, and a check whose findings are half false positives is a
 * check people learn to skip.
 *
 * ### It runs your model files
 *
 * There is no way to find a class without evaluating the module that declares
 * it, so every file this walks is imported, and a file that *does something*
 * when imported does it here. That is not hypothetical: the first run of this
 * command against the template imported `app/models/bench/run.ts`, which is a
 * benchmark, and it duly ran the benchmark and rewrote its report.
 *
 * The exclusions above keep tests and vendored packages out. `--ignore` is for
 * the rest, and what it skipped is printed, so a narrowed run does not read
 * like a complete one.
 */

/** The problems one run found, plus enough to say what was covered. */
export interface CheckReport {
  /** Model files that were walked and imported. */
  files: string[];
  /** Model classes the declared modules registered. */
  registered: number;
  /**
   * `--ignore` patterns this run honoured. Printed, so a run that covered less
   * than the directory says so rather than reading as though it covered
   * everything.
   */
  ignored: string[];
  findings: Finding[];
}

export interface Finding {
  /** Path relative to the project root, for the printed report. */
  file: string;
  /** The class whose policies are not in effect inside an `include`. */
  className: string;
  message: string;
}

/**
 * The ORM's own surface, as this file uses it.
 *
 * Injected rather than imported, and the reason is a hazard rather than a
 * preference. This command is bundled into `dist/bin/gemi.js`, so a static
 * `import { auditModelRegistrations } from "../orm/registration"` would bundle a
 * *second* copy of the registry — while the app's model files resolve
 * `gemi/orm` from the app's own `node_modules` and populate the first. The check
 * would then read an empty registry and report every model in the project.
 *
 * So the ORM is resolved from the project being checked, at runtime, and the
 * static import above is type-only.
 */
export interface OrmSurface {
  auditModelRegistrations: (
    ...modules: Array<Record<string, unknown>>
  ) => UnregisteredPolicyClassError[];
  registerModels: (...modules: Array<Record<string, unknown>>) => void;
  registry: {
    register: (name: string, model: unknown) => void;
    get: <T = unknown>(name: string) => T;
    registeredNames: () => string[];
  };
}

/**
 * Files that could hold a model class.
 *
 * Everything under the directory, because apps do group models into folders,
 * minus what cannot be one. The check has to *import* each of these, so the
 * exclusions are about what is certainly not model source rather than about
 * what is probably not:
 *
 *   - **Declaration files.** `.d.ts` has no runtime module behind it.
 *   - **Tests, type tests and benchmarks**, by the suffix a runner already
 *     recognises.
 *   - **Dot-directories and `node_modules`.**
 *   - **Any directory holding a `package.json`.** That is a package that
 *     happens to live here — a vendored client, a generated SDK — not this
 *     app's source, and importing its entry point runs somebody else's module
 *     graph. The template has two.
 *
 * `generated/` is deliberately *not* skipped. It is one of the declared
 * modules, so its classes are registered and produce no findings — and skipping
 * a directory because of its name would be one more inference about generator
 * output, which is the thing #318's other half is about.
 *
 * `ignore` is the escape hatch for the rest: a path prefix, relative to `dir`,
 * for a directory of model-adjacent code that runs something on import. Nothing
 * is ignored by default, and the command prints what was.
 */
export function modelFiles(dir: string, ignore: string[] = []): string[] {
  const out: string[] = [];

  const ignored = (path: string) => {
    const rel = relative(dir, path).split("\\").join("/");
    return ignore.some(
      (pattern) => rel === pattern || rel.startsWith(`${pattern}/`),
    );
  };

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const path = join(current, entry.name);
      if (ignored(path)) continue;

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (existsSync(join(path, "package.json"))) continue;
        walk(path);
        continue;
      }

      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (/\.(test|test-d|spec|bench)\.tsx?$/.test(entry.name)) continue;

      out.push(path);
    }
  };

  walk(dir);
  return out;
}

/** What the registry held at a moment, enough to put it back. */
export type RegistrySnapshot = ReadonlyArray<readonly [string, unknown]>;

/**
 * The registry as the declared modules left it.
 *
 * Taken *before* a single model file is imported, and that ordering is the
 * whole of it: importing a file runs it, and a model file written the pre-0.51
 * way ends in `register("User", User)`. A snapshot taken afterwards would
 * already contain the answer the check is supposed to be testing.
 *
 * `register` has no inverse, so a name the baseline does not hold cannot be
 * restored to absent. In an app that has one it is a model the generated
 * modules never emitted, which is a different thing entirely; and this is a
 * process that is about to exit.
 */
export function snapshotRegistry(orm: OrmSurface): RegistrySnapshot {
  return orm.registry
    .registeredNames()
    .map((name) => [name, orm.registry.get(name)] as const);
}

/**
 * The audit itself: what the Kernel declares, against what the directory holds.
 *
 * `baseline` is the registry the application actually boots with. Each file's
 * module is audited against it in isolation — restored first, so a `register`
 * call that ran while some file was importing cannot answer for any of them.
 */
export function auditModules(
  orm: OrmSurface,
  files: Array<{ path: string; label: string; module: Record<string, unknown> }>,
  baseline: RegistrySnapshot,
): Finding[] {
  const restore = () => {
    for (const [name, model] of baseline) orm.registry.register(name, model);
  };

  const findings: Finding[] = [];

  for (const file of files) {
    restore();

    for (const problem of orm.auditModelRegistrations(file.module)) {
      // The arrangement `registerModels` refuses on purpose, and the arrangement
      // its error tells the author to keep out of the declared modules. Being
      // absent from them is what it is *supposed* to look like.
      if (problem.carries === "narrowing") continue;

      findings.push({
        file: file.label,
        className: problem.queried,
        message: problem.message,
      });
    }
  }

  restore();

  return findings;
}

/** A condition that makes the check meaningless, phrased for the terminal. */
export class CheckModelsError extends Error {}

/**
 * Loads the project's Kernel and returns the model modules it declares.
 *
 * The Kernel is where the modules are named, so it is where the check has to
 * read them from — inferring the list from a filename convention would let the
 * check pass on an app whose Kernel declares nothing, which is the state #316
 * describes.
 *
 * `models` is `protected`, which is a statement about application code rather
 * than about the framework's own tooling; the cast is that distinction.
 */
async function declaredModules(
  rootDir: string,
): Promise<Array<Record<string, unknown>>> {
  const path = resolve(rootDir, "app/kernel/Kernel.ts");

  let Kernel: new () => { models?: Array<Record<string, unknown>> };
  try {
    ({ default: Kernel } = (await import(path)) as {
      default: new () => { models?: Array<Record<string, unknown>> };
    });
  } catch (error) {
    throw new CheckModelsError(
      `Could not load ${relative(rootDir, path)}:\n    ` +
        `${(error as Error).message}`,
    );
  }

  // Constructed, not booted. `boot()` installs the Application as the
  // process-wide instance and registers every provider, none of which this needs
  // — and one of which might well open a connection.
  return new Kernel().models ?? [];
}

/**
 * Runs the check against a project directory.
 *
 * Throws `CheckModelsError` for the conditions that make the check meaningless
 * rather than failing — a missing Kernel, an empty `models`, a model file that
 * cannot be imported — because each is a different sentence to print and none of
 * them is a finding about a model class.
 */
export async function checkModels(options: {
  rootDir: string;
  modelsDir?: string;
  ignore?: string[];
}): Promise<CheckReport> {
  const rootDir = resolve(options.rootDir);
  const modelsDir = resolve(rootDir, options.modelsDir ?? "app/models");
  const ignore = options.ignore ?? [];

  let orm: OrmSurface;
  try {
    orm = (await import(Bun.resolveSync("gemi/orm", rootDir))) as OrmSurface;
  } catch {
    throw new CheckModelsError(
      `Could not resolve \`gemi/orm\` from ${rootDir}. Run this from the root ` +
        `of a gemi project.`,
    );
  }

  if (typeof orm.auditModelRegistrations !== "function") {
    throw new CheckModelsError(
      "The gemi installed in this project is older than `gemi check models`. " +
        "Upgrade it to 0.51 or newer.",
    );
  }

  try {
    statSync(modelsDir);
  } catch {
    throw new CheckModelsError(`No model directory at ${modelsDir}.`);
  }

  const declared = await declaredModules(rootDir);
  if (declared.length === 0) {
    throw new CheckModelsError(
      "`Kernel.models` is empty, so nothing is registered from a module and " +
        "there is no arrangement to check against.\n" +
        "Declare the model modules in `app/kernel/Kernel.ts`:\n\n" +
        '    import * as generated from "../models/generated";\n' +
        '    import * as models from "../models";\n\n' +
        "    export default class extends Kernel {\n" +
        "      models = [generated, models];\n" +
        "    }\n\n" +
        "See UPGRADE.md and docs/orm.md#your-model-class.",
    );
  }

  // Registers, and audits what it registered — so a problem in the declared set
  // is reported by the framework's own error rather than restated here. It is
  // also the problem this app has *first*: the check below compares files
  // against an arrangement that, in this case, would not boot.
  try {
    orm.registerModels(...declared);
  } catch (error) {
    throw new CheckModelsError(
      `The modules \`Kernel.models\` declares do not register cleanly, so ` +
        `this app would refuse to boot before reaching anything below:\n\n` +
        `${(error as Error).message}`,
    );
  }

  // Before the first import, for the reason `snapshotRegistry` gives.
  const baseline = snapshotRegistry(orm);

  const paths = modelFiles(modelsDir, ignore);
  const files: Array<{
    path: string;
    label: string;
    module: Record<string, unknown>;
  }> = [];

  for (const path of paths) {
    const label = relative(rootDir, path);
    try {
      files.push({
        path,
        label,
        module: (await import(path)) as Record<string, unknown>,
      });
    } catch (error) {
      // A file that will not import is a file the check did not cover, and a
      // check that quietly covers less than it claims is worse than one that
      // stops.
      throw new CheckModelsError(
        `${label} could not be imported, so it could not be checked:\n` +
          `    ${(error as Error).message}`,
      );
    }
  }

  return {
    files: files.map((file) => file.label),
    registered: baseline.length,
    ignored: ignore,
    findings: auditModules(orm, files, baseline),
  };
}

/** The report as the command prints it. Returns the process exit code. */
export function printReport(report: CheckReport, log = console.log): number {
  // Printed either way. A run that skipped part of the directory and said
  // nothing about it reads exactly like one that covered all of it.
  if (report.ignored.length > 0) {
    log(`Ignoring ${report.ignored.join(", ")}.`);
  }

  if (report.findings.length === 0) {
    log(
      `Checked ${report.files.length} model file${report.files.length === 1 ? "" : "s"} ` +
        `against ${report.registered} registered model${report.registered === 1 ? "" : "s"}. ` +
        `Every policied class owns its name.`,
    );
    return 0;
  }

  for (const finding of report.findings) {
    // The error's own message, and then the fix for *this* command's version of
    // the problem. Its advice — write a `register` line — is a correct fix and
    // the direct one where it is thrown, at a query or over a module somebody
    // handed the audit. Here the class was found by walking a directory, so the
    // thing that went missing is the export, and re-registering by hand puts the
    // app back on the mechanism 0.51 replaced.
    log(
      `\n${finding.file}\n${indent(finding.message)}\n` +
        indent(
          `Or export it from a module \`Kernel.models\` declares, which is ` +
            `what makes\n` +
            `the registration survive without a \`register\` line:\n\n` +
            `    export { ${finding.className} } from "./${basename(finding.file).replace(/\.tsx?$/, "")}"\n`,
        ),
    );
  }

  log(
    `\n${report.findings.length} model class${report.findings.length === 1 ? "" : "es"} ` +
      `${report.findings.length === 1 ? "is" : "are"} not registered by the modules ` +
      `\`Kernel.models\` declares. Every nested read of ${report.findings.length === 1 ? "it" : "them"} ` +
      `runs the class that is, so the policies above are not in effect inside an \`include\`.`,
  );

  return 1;
}

function indent(message: string): string {
  return message
    .split("\n")
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join("\n");
}
