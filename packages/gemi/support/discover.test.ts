import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import {
  DiscoveryError,
  discoverClasses,
  projectRoot,
  sourceFiles,
} from "./discover";

/**
 * The walk #322 and #323 both stand on.
 *
 * Two halves, and they fail in opposite directions. The walker decides which
 * files are imported at all, so its mistakes are silent: a rule that skips one
 * file too many produces a job that is never registered and never complained
 * about, which is the failure discovery was built to remove. `discoverClasses`
 * decides what counts as a class worth returning, and its mistakes are loud —
 * scheduling an abstract base, or a helper function that happens to be
 * exported.
 *
 * So both halves are asserted against a real directory rather than a mock: the
 * skip rules are only true of a filesystem, and a fixture that imports nothing
 * from `gemi` is what lets these projects live in a temp directory with no
 * `node_modules` above them. That is also why `discoverClasses` takes its base
 * class as an argument — the fixtures below declare their own and hand it back.
 */

const roots: string[] = [];

const write = (root: string, path: string, source: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), source);
};

/** A directory of empty files, for the questions that are only about paths. */
const tree = (files: string[]): string => {
  const root = mkdtempSync(join(tmpdir(), "gemi-discover-"));
  roots.push(root);
  for (const file of files) write(root, file, "");
  return root;
};

/** A directory of real modules, for the questions that are about what is in them. */
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "gemi-discover-project-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) write(root, path, source);
  return root;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The base every fixture below extends, written into the fixture itself. */
const BASE = `export class Base {
  run() {}
}`;

/** Reads the fixture's own base class back out, so identity holds. */
const baseOf = async (root: string) =>
  (
    (await import(join(root, "base.ts"))) as {
      Base: abstract new () => unknown;
    }
  ).Base;

const names = (classes: Array<{ name: string }>) =>
  classes.map((value) => value.name);

describe("which files the walk offers", () => {
  const relative = (root: string, paths: string[]) =>
    paths.map((path) => path.slice(root.length + 1));

  test("walks nested directories, because apps group classes into folders", () => {
    const root = tree(["index.ts", "billing/Invoice.ts", "billing/Plan.ts"]);

    expect(relative(root, sourceFiles(root))).toEqual([
      "billing/Invoice.ts",
      "billing/Plan.ts",
      "index.ts",
    ]);
  });

  /**
   * The files certain not to declare a job and most likely to be expensive to
   * import. A test file next to the job it tests is the ordinary layout, and
   * importing it at boot would run the suite inside the server.
   */
  test("skips tests, type tests and benchmarks", () => {
    const root = tree([
      "SendEmail.ts",
      "SendEmail.test.ts",
      "dispatch.test-d.ts",
      "throughput.bench.ts",
      "retries.spec.ts",
    ]);

    expect(relative(root, sourceFiles(root))).toEqual(["SendEmail.ts"]);
  });

  test("skips node_modules and dot-directories", () => {
    const root = tree([
      "SendEmail.ts",
      "node_modules/pkg/index.ts",
      ".cache/thing.ts",
    ]);

    expect(relative(root, sourceFiles(root))).toEqual(["SendEmail.ts"]);
  });

  /** `.d.ts` ends in `.ts` and has no runtime module behind it. */
  test("skips declaration files", () => {
    const root = tree(["SendEmail.ts", "client/index.d.ts"]);

    expect(relative(root, sourceFiles(root))).toEqual(["SendEmail.ts"]);
  });

  test("ignores files that are not TypeScript", () => {
    const root = tree(["SendEmail.ts", "queue.json", "notes.md", "dev.db"]);

    expect(relative(root, sourceFiles(root))).toEqual(["SendEmail.ts"]);
  });

  /**
   * A directory with a `package.json` is a package that happens to live here —
   * a vendored client, a generated SDK — and importing its entry point runs
   * somebody else's module graph.
   */
  test("skips a vendored package", () => {
    const root = tree([
      "SendEmail.ts",
      "prisma-client/package.json",
      "prisma-client/index.ts",
    ]);

    expect(relative(root, sourceFiles(root))).toEqual(["SendEmail.ts"]);
  });

  test("`ignore` skips a path and everything under it", () => {
    const root = tree(["SendEmail.ts", "bench/run.ts", "bench/harness.ts"]);

    expect(relative(root, sourceFiles(root, ["bench"]))).toEqual([
      "SendEmail.ts",
    ]);
  });

  test("`ignore` can name a single file", () => {
    const root = tree(["SendEmail.ts", "bench/run.ts", "bench/harness.ts"]);

    expect(relative(root, sourceFiles(root, ["bench/run.ts"]))).toEqual([
      "SendEmail.ts",
      "bench/harness.ts",
    ]);
  });

  /**
   * `readdirSync` returns the filesystem's order, not a sorted one, so the sort
   * inside the walk is what makes two runs over one tree agree — and the caller
   * is a scheduler importing in that order. Sorting per directory rather than
   * sorting the finished list is what puts `a/b.ts` before `a.ts`.
   */
  test("is ordered the same on every run, directories before their siblings", () => {
    const root = tree(["a.ts", "a/b.ts", "b.ts"]);

    expect(relative(root, sourceFiles(root))).toEqual([
      "a/b.ts",
      "a.ts",
      "b.ts",
    ]);
    expect(sourceFiles(root)).toEqual(sourceFiles(root));
  });

  /**
   * An app that has not written its first job yet is an ordinary state, and
   * throwing at it would make discovery something an app has to opt out of by
   * creating an empty directory.
   */
  test("a directory that is not there is an empty list, not a throw", () => {
    const root = tree(["SendEmail.ts"]);

    expect(sourceFiles(join(root, "nowhere"))).toEqual([]);
  });
});

describe("which classes come back", () => {
  /**
   * The order is the walk's, which is per-directory and by codepoint — so
   * `SendEmail.ts` comes before the `billing/` beside it, and a run that
   * reordered itself between two boots would show up here.
   */
  test("a subclass in each file, in the walk's order", async () => {
    const root = project({
      "base.ts": BASE,
      "SendEmail.ts": `import { Base } from "./base";
        export class SendEmail extends Base {}`,
      "billing/Invoice.ts": `import { Base } from "../base";
        export class Invoice extends Base {}`,
    });

    const found = await discoverClasses(root, await baseOf(root));

    expect(names(found)).toEqual(["SendEmail", "Invoice"]);
  });

  /**
   * The shape an app reaches for the moment several jobs share a gate: a base
   * of its own, in the same directory, exported like everything else. A
   * framework that scheduled it would be running a job nobody wrote.
   */
  test("the base itself is never one of them, even where it is exported beside them", async () => {
    const root = project({
      "base.ts": BASE,
      "Reporting.ts": `import { Base } from "./base";
        export abstract class Reporting extends Base {}`,
      "Weekly.ts": `import { Reporting } from "./Reporting";
        export class Weekly extends Reporting {}`,
    });

    const found = await discoverClasses(root, await baseOf(root));

    expect(names(found)).toEqual(["Reporting", "Weekly"]);
  });

  test("a subclass two levels down the chain still matches", async () => {
    const root = project({
      "base.ts": BASE,
      "chain.ts": `import { Base } from "./base";
        class Middle extends Base {}
        class Inner extends Middle {}
        export class Leaf extends Inner {}`,
    });

    const found = await discoverClasses(root, await baseOf(root));

    expect(names(found)).toEqual(["Leaf"]);
  });

  /**
   * A directory holds more than its classes — a helper, a schedule constant, a
   * type. `typeof value === "function"` is true of the helper too, so the
   * prototype chain is what has to answer, not the typeof.
   */
  test("an export that is not a subclass is not one of them", async () => {
    const root = project({
      "base.ts": BASE,
      "SendEmail.ts": `import { Base } from "./base";
        export class SendEmail extends Base {}
        export class Formatter {}
        export function helper() {}
        export const EVERY_MINUTE = "* * * * *";
        export default { name: "not a class" };`,
    });

    const found = await discoverClasses(root, await baseOf(root));

    expect(names(found)).toEqual(["SendEmail"]);
  });

  /**
   * A barrel beside the classes it re-exports is the ordinary layout, and it
   * makes every one of them reachable twice. Registering a cron twice is two
   * `Bun.cron` handles on one schedule.
   */
  test("a class re-exported by a barrel comes back once", async () => {
    const root = project({
      "base.ts": BASE,
      "SendEmail.ts": `import { Base } from "./base";
        export class SendEmail extends Base {}`,
      "index.ts": `export { SendEmail } from "./SendEmail";`,
    });

    const found = await discoverClasses(root, await baseOf(root));

    expect(names(found)).toEqual(["SendEmail"]);
    expect(found).toHaveLength(1);
  });

  /**
   * `export default class` is how a file holding exactly one class often reads,
   * and a module namespace names it `default` like anything else — so the rule
   * is about the prototype chain, not about the export being named.
   */
  test("a default export counts", async () => {
    const root = project({
      "base.ts": BASE,
      "SendEmail.ts": `import { Base } from "./base";
        export default class SendEmail extends Base {}`,
    });

    const found = await discoverClasses(root, await baseOf(root));

    expect(names(found)).toEqual(["SendEmail"]);
  });

  test("`ignore` keeps a directory out of the walk and out of the answer", async () => {
    const root = project({
      "base.ts": BASE,
      "SendEmail.ts": `import { Base } from "./base";
        export class SendEmail extends Base {}`,
      "bench/Throughput.ts": `import { Base } from "../base";
        export class Throughput extends Base {}`,
    });

    const found = await discoverClasses(root, await baseOf(root), ["bench"]);

    expect(names(found)).toEqual(["SendEmail"]);
  });

  test("a directory that is not there discovers nothing", async () => {
    const root = project({ "base.ts": BASE });

    expect(
      await discoverClasses(join(root, "nowhere"), await baseOf(root)),
    ).toEqual([]);
  });

  /**
   * The red path, and the one worth spelling out. A file that will not import
   * is a class the caller was going to be told about and now is not, so it
   * stops the walk — but the throw a failed dynamic import produces names the
   * specifier that would not resolve, several frames deep, and nothing about
   * the walk that asked for it. Naming the file, and the way out, is the whole
   * difference between a boot failure somebody can act on and a stack trace.
   */
  test("a file that will not import names itself, and the way out", async () => {
    const root = project({
      "base.ts": BASE,
      "Broken.ts": `throw new Error("a template this needs is not a module");`,
    });

    const failure = await discoverClasses(root, await baseOf(root)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DiscoveryError);
    const error = failure as DiscoveryError;
    expect(error.message).toContain(join(root, "Broken.ts"));
    expect(error.message).toContain("a template this needs is not a module");
    expect(error.message).toContain("List the classes explicitly");
    // The original is kept, because the message above summarises a stack that
    // is the only thing naming the specifier that actually failed.
    expect(error.cause).toBeInstanceOf(Error);
  });
});

/**
 * The rule every relative `jobsDir` is resolved by.
 *
 * It has no caller inside this file's other tests and none inside the
 * discovery tests either — those all name an absolute directory, because a
 * fixture in `tmpdir()` has no other way to be found. So the one line that
 * turns `"app/cron"` into a path is the one line nothing was exercising, and
 * deleting it left the whole suite green while pointing every deployment that
 * sets `GEMI_PROJECT_DIR` at the wrong directory — where it would find no jobs
 * and say nothing, which is the failure this feature exists to remove.
 */
describe("where a relative directory is resolved from", () => {
  const previous = process.env.GEMI_PROJECT_DIR;

  afterEach(() => {
    if (previous === undefined) delete process.env.GEMI_PROJECT_DIR;
    else process.env.GEMI_PROJECT_DIR = previous;
  });

  test("the working directory, when nothing says otherwise", () => {
    delete process.env.GEMI_PROJECT_DIR;

    expect(projectRoot()).toBe(process.cwd());
  });

  test("the subdirectory `GEMI_PROJECT_DIR` names, the way httpProd reads it", () => {
    process.env.GEMI_PROJECT_DIR = "packages/app";

    expect(projectRoot()).toBe(join(process.cwd(), "packages/app"));
  });
});
