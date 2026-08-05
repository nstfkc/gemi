import { statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { sourceFiles } from "../support/discover";
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
 * **It reports one of the audit's three answers.** `carries === "queried"` — a
 * class carrying policies the registered one does not — and neither of the
 * others, because both are arrangements the framework itself asked for:
 * `narrowing` is a policied view, which `registerModels` refuses so that its
 * scope does not silently reach every nested read, and whose error says to keep
 * it out of `Kernel.models`; `registered` is an unpolicied class claiming a
 * policied model's name, which `AmbiguousModelRegistrationError` likewise says
 * to keep out. A checker that demanded either be exported from the barrel would
 * be telling an author to undo what an error told them to do.
 *
 * **So it does not report an unpolicied class.** One missing from the declared
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
 * The exclusions `sourceFiles` applies keep tests and vendored packages out.
 * `--ignore` is for the rest, and what it skipped is printed, so a narrowed run
 * does not read like a complete one.
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
  /** Path relative to the project root, for the printed report's heading. */
  file: string;
  /**
   * The module specifier a barrel in the model directory's root would import
   * this file by — `./billing/Invoice`.
   *
   * Separate from `file` because they differ the moment a model lives in a
   * subdirectory, and the printed fix is an `export … from` line: `file` is
   * relative to the *project* root, and pasting a specifier derived from its
   * basename into `app/models/index.ts` gives a module that does not resolve.
   */
  specifier: string;
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
    clearRegistry: () => void;
  };
}

/**
 * Files that could hold a model class.
 *
 * The walk itself is `sourceFiles`, which this command shared with job and cron
 * discovery when #322 asked for one mechanism rather than three. Its skip rules
 * are written down there, and they are these ones: the question "which files
 * under this directory might declare a class, given that answering means
 * importing every one of them" has the same answer for models, jobs and crons.
 *
 * What stays here is what is true of models in particular. `generated/` is
 * deliberately *not* skipped — it is one of the declared modules, so its classes
 * are registered and produce no findings, and skipping a directory because of
 * its name would be one more inference about generator output, which is the
 * thing #318's other half is about. And `ignore` is the escape hatch the
 * `--ignore` flag fills, for model-adjacent code that runs something on import;
 * the command prints what it honoured, so a narrowed run does not read like a
 * complete one.
 *
 * A missing directory yields an empty list rather than throwing, which changes
 * nothing for this command: `checkModels` stats the model directory first and
 * says so in a sentence worth printing.
 */
export function modelFiles(dir: string, ignore: string[] = []): string[] {
  return sourceFiles(dir, ignore);
}

/** What the registry held at a moment, enough to put it back. */
export type RegistrySnapshot = ReadonlyArray<readonly [string, unknown]>;

/**
 * The registry as the declared modules left it.
 *
 * **What makes this the declared arrangement is `registerModels`, not the
 * moment this is called.** The obvious reading — "taken before any model file
 * is imported" — is false: loading the Kernel to read `models` off it imports
 * `../models/generated` and `../models` on the way, so by the time this runs
 * the generated `index.ts` has already run its `register` calls and every file
 * the barrel reaches has run its top-level side effects, legacy
 * `register("User", User)` lines included.
 *
 * What restores the property is that `registerModels(...declared)` runs after
 * all of that and re-asserts the election over whatever the imports left. So
 * this snapshot is the arrangement the app boots with regardless of what ran
 * during the loading — and the files walked *after* it are the ones whose
 * import-time `register` calls the audit must not credit.
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
  files: Array<{
    label: string;
    specifier: string;
    module: Record<string, unknown>;
  }>,
  baseline: RegistrySnapshot,
): Finding[] {
  // Cleared rather than overwritten, so a name the baseline does not hold —
  // registered by some file's own import — goes away instead of surviving into
  // the next file's audit.
  const restore = () => {
    orm.registry.clearRegistry();
    for (const [name, model] of baseline) orm.registry.register(name, model);
  };

  const findings: Finding[] = [];

  for (const file of files) {
    restore();

    for (const problem of orm.auditModelRegistrations(file.module)) {
      // Only `queried` — "this class carries policies the registered one does
      // not" — is this command's business. The other two are shapes it would be
      // wrong to report:
      //
      //   `narrowing` is a policied view, which `registerModels` refuses
      //   *because* registering it would apply its scope to every nested read,
      //   and whose error tells the author to keep it out of the declared
      //   modules. Being absent from them is what following that advice looks
      //   like.
      //
      //   `registered` is the mirror image: an *unpolicied* class claiming a
      //   name the registered class carries policies for. That contradicts this
      //   command's own rule about unpolicied classes, and its message is
      //   written for a call site — "query the registered one instead" — under
      //   which the export line printed below would land two unrelated classes
      //   in one namespace and turn a working boot into
      //   `AmbiguousModelRegistrationError`.
      if (problem.carries !== "queried") continue;

      findings.push({
        file: file.label,
        specifier: file.specifier,
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
 * The modules named by `--models`, imported in the order given.
 *
 * **Why an app would want this instead of the Kernel.** Reading the list off
 * `Kernel.models` means importing the Kernel, and that drags in the whole
 * Kernel import graph — config slices, providers, and whatever they reach. A
 * gemi app's does not have to be resolvable by a bare runtime import: `?raw`
 * imports, virtual modules and asset imports are ordinary, and a bundler
 * resolves them where `await import()` does not. The app that reported #316 and
 * #318 is exactly that app; its Kernel transitively reaches a `.md?raw` import
 * and the command cannot load it.
 *
 * It fails loudly there rather than passing green, which is the right failure —
 * but a command that cannot run on the project that asked for it is not much
 * use, and the whole check needs is the *model* modules.
 *
 * This is not the filename convention `declaredModules` rejects. That guess
 * would let the check pass on an app whose Kernel declares nothing, because the
 * tool would have supplied the list the app failed to. A flag is the author
 * stating it, which is the same act as writing `models = [...]` — and if they
 * state the wrong list, they see it in the count the report prints.
 */
async function namedModules(
  rootDir: string,
  paths: string[],
): Promise<Array<Record<string, unknown>>> {
  const modules: Array<Record<string, unknown>> = [];

  for (const path of paths) {
    const resolved = resolve(rootDir, path);
    try {
      modules.push((await import(resolved)) as Record<string, unknown>);
    } catch (error) {
      throw new CheckModelsError(
        `--models named ${path}, which could not be imported:\n    ` +
          `${(error as Error).message}`,
      );
    }
  }

  return modules;
}

/**
 * Loads the project's Kernel and returns the model modules it declares.
 *
 * The Kernel is where the modules are named, so it is where the check reads
 * them from by default — inferring the list from a filename convention would
 * let the check pass on an app whose Kernel declares nothing, which is the
 * state #316 describes. `--models` is the way to say it directly; see
 * `namedModules`.
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
  /**
   * Module paths to register from, instead of reading `Kernel.models`. Empty or
   * absent means load the Kernel, which is the default and the better answer
   * when it works — see `namedModules`.
   */
  models?: string[];
  /**
   * The ORM to check against, for a test holding a fixture project rather than
   * an installation. The command never passes it: resolving `gemi/orm` from the
   * project is the point, and a fixture written into a temp directory has no
   * `node_modules` above it to resolve through.
   */
  orm?: OrmSurface;
}): Promise<CheckReport> {
  const rootDir = resolve(options.rootDir);
  const modelsDir = resolve(rootDir, options.modelsDir ?? "app/models");
  const ignore = options.ignore ?? [];

  let orm: OrmSurface;
  try {
    orm =
      options.orm ??
      ((await import(Bun.resolveSync("gemi/orm", rootDir))) as OrmSurface);
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

  const named = options.models ?? [];
  const declared =
    named.length > 0
      ? await namedModules(rootDir, named)
      : await declaredModules(rootDir);

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
        "Or name them directly, for a Kernel this command cannot import:\n\n" +
        "    gemi check models --models app/models/generated,app/models\n\n" +
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

  // After `registerModels`, which is what makes it the declared arrangement —
  // see `snapshotRegistry`.
  const baseline = snapshotRegistry(orm);

  const paths = modelFiles(modelsDir, ignore);
  const files: Array<{
    label: string;
    specifier: string;
    module: Record<string, unknown>;
  }> = [];

  for (const path of paths) {
    const label = relative(rootDir, path);
    // What a barrel at the model directory's root would import this file by,
    // which is what the printed fix is a line of. Relative to `modelsDir`, not
    // to `rootDir`, and not the basename: `app/models/billing/Invoice.ts` is
    // `./billing/Invoice` there and `./Invoice` nowhere.
    const specifier = `./${relative(modelsDir, path)
      .split("\\")
      .join("/")
      .replace(/\.tsx?$/, "")}`;

    try {
      files.push({
        label,
        specifier,
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
            `    export { ${finding.className} } from "${finding.specifier}"\n`,
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
