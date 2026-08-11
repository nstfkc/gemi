import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Finding the classes an application declared and never imported — the walk
 * #322 and #323 both end at.
 *
 * ### Why it has to run the files
 *
 * A job that is written and not listed does not fail; it disappears.
 * `QueueManager.next` looks a dispatched name up in the map its config built and
 * skips what is not there, so the dispatch is simply lost. A cron drifts worse:
 * nothing is waiting on a tick, so a job that never fires reports nothing to
 * anyone. What both come down to is that `app/config/queue.ts` naming every
 * `Job` subclass is the *only* thing putting those classes in the module graph —
 * the list and the directory are two spellings of one set, kept in step by hand.
 *
 * The way out of that is to read the directory, and there is no static read that
 * will do: the class does not exist until its module has run. So **every file
 * walked here is imported**, and a file that *does something* when imported does
 * it here — at boot, in production, on every start. `gemi check models` makes
 * the same trade for the same reason and pays it once per CI run; a caller of
 * this pays it once per process.
 *
 * ### What that asks of a caller
 *
 * **Point it at a directory of class declarations, not at `app/`.** The skip
 * rules on `sourceFiles` drop what certainly is not one — tests, benchmarks,
 * `.d.ts`, vendored packages — and nothing else. Widening the guesses is how a
 * discovery pass ends up quietly covering less than the directory holds, which
 * is the same silence in a new place.
 *
 * **Let a broken file stop the boot.** `discoverClasses` rethrows an import
 * failure naming the file rather than dropping it and carrying on, for the same
 * reason: four classes found out of five looks exactly like five out of five.
 *
 * **Leave a way out.** Discovery is what should happen when an app said
 * nothing. An app that lists its classes explicitly must not reach this file at
 * all — that is the escape hatch for a directory holding something this cannot
 * import, and it is the sentence an error from here should point at.
 *
 * ### One more thing worth knowing
 *
 * This imports by absolute path, while the application imports the same files
 * through the `@/app/*` alias. Bun keys its module registry by the *resolved*
 * path, so those two specifiers land on one module: a job already reached from
 * a controller is not evaluated a second time here, and the class object is the
 * same one. `gemi build` leaves that true in production — `packages: "external"`
 * keeps the app's own code out of `dist/server/server.mjs` and resolves it from
 * source at runtime, exactly as `gemi dev` does.
 *
 * Nothing here depends on that holding, and deliberately: `QueueManager` and the
 * `Scheduler`'s cross-reload registry are both keyed by name rather than by
 * class identity, so a build that did inline the app's modules would produce a
 * duplicate class object and still register the right job. Worth knowing before
 * writing a registry keyed the other way.
 */

/**
 * The files under `dir` that could declare a class.
 *
 * Everything underneath it, because apps do group classes into folders, minus
 * what cannot be one. Each of these is going to be *imported*, so the exclusions
 * are about what is certainly not source rather than about what is probably not:
 *
 *   - **Declaration files.** `.d.ts` has no runtime module behind it.
 *   - **Tests, type tests and benchmarks**, by the suffix a runner already
 *     recognises.
 *   - **Dot-directories and `node_modules`.**
 *   - **Any directory holding a `package.json`.** That is a package that happens
 *     to live here — a vendored client, a generated SDK — not this app's source,
 *     and importing its entry point runs somebody else's module graph. The
 *     template has two under `app/models`.
 *
 * `ignore` is the escape hatch for the rest: a path prefix, relative to `dir`,
 * naming a file or a directory of adjacent code that runs something on import.
 * Nothing is ignored by default.
 *
 * The order is the same on every run over the same tree, which matters because
 * the caller is going to import in it: entries are sorted per directory before
 * recursing, and `readdirSync` order is the filesystem's rather than
 * alphabetical — a tree written `A.ts` then `B.ts` reads back `B.ts` first on
 * the machines this was tested on. Sorting per directory rather than sorting the
 * finished list is deliberate: for a tree holding both `a.ts` and `a/b.ts`, this
 * emits `a/b.ts` first, because the directory sorts before the file.
 *
 * A directory that does not exist yields an empty list rather than throwing.
 * "The app has no jobs yet" is an ordinary state and not this function's to
 * complain about — but it is indistinguishable from "the app's source did not
 * ship", so a caller that boots on the answer owes the reader a word about which
 * one it got.
 */
export function sourceFiles(dir: string, ignore: string[] = []): string[] {
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
        if (entry.name.startsWith(".") || entry.name === "node_modules")
          continue;
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

  if (!existsSync(dir)) return out;

  walk(dir);
  return out;
}

/**
 * A class, as much of one as this file can name. `abstract` so that a base an
 * app never instantiates directly is a legal argument.
 */
type ClassLike = abstract new (...args: never[]) => unknown;

/**
 * A file that would not import, reported with the file that would not import.
 *
 * Separate from a bare rethrow because the stack of a failed dynamic import
 * names the module that failed to *resolve*, several frames deep, and says
 * nothing about the walk that asked for it — so the reader learns that some
 * `?raw` specifier is unresolvable without learning that discovery is what
 * imported it, or that listing the classes explicitly is how they get their boot
 * back.
 */
export class DiscoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscoveryError";
  }
}

/**
 * Every exported class under `dir` whose prototype chain reaches `base`.
 *
 * `base` is a parameter rather than an import so that this file names no
 * service and stays cheap to depend on — `bin/check-models.ts` uses the walker
 * above and is bundled into `dist/bin/gemi.js`, which is not somewhere gemi's
 * service layer should end up. It is also what lets a test hand in a base class
 * of its own instead of standing up a project that can resolve `gemi/services`.
 *
 * `base` itself is never returned. A directory whose files import their base
 * from a sibling — the shape an app reaches for when several jobs share a gate —
 * re-exports it as often as not, and a framework that scheduled the abstract
 * base along with its subclasses would be running a job nobody wrote.
 *
 * A class is returned once no matter how many exports name it. A barrel in the
 * directory re-exporting everything beside it is the ordinary case, and it makes
 * every class reachable twice.
 *
 * The order is the walk's, and within a file the module namespace's, which the
 * language sorts by name. So the answer is the same on every run — worth having
 * where the caller is a scheduler and the alternative is a boot order that
 * depends on the filesystem.
 *
 * `onSkipped` is handed every export that did *not* match, with the file it came
 * from. Discovery's characteristic failure is a thing the author wrote and this
 * walk cannot see, and by the time an export has been discarded here the
 * information about why is gone — the caller is left holding "four classes"
 * where the directory holds five. A caller that can recognise its own
 * near-misses, as `discoverCommands` recognises a builder chain that was never
 * finished, uses this to say so by name instead.
 *
 * @throws DiscoveryError if a walked file cannot be imported. Not a skip: a file
 * that will not load is a class the caller was going to be told about and now is
 * not, which is the failure discovery exists to remove.
 */
export async function discoverClasses<T extends ClassLike>(
  dir: string,
  base: T,
  ignore: string[] = [],
  onSkipped?: (value: unknown, file: string) => void,
): Promise<T[]> {
  const found = new Set<T>();

  for (const path of sourceFiles(dir, ignore)) {
    let module: Record<string, unknown>;

    try {
      module = (await import(path)) as Record<string, unknown>;
    } catch (error) {
      throw new DiscoveryError(
        `${path} could not be imported, so the classes in it could not be ` +
          `discovered:\n    ${(error as Error).message}\n` +
          `List the classes explicitly in the config slice for this directory ` +
          `to skip the walk.`,
        { cause: error },
      );
    }

    for (const value of Object.values(module)) {
      if (
        typeof value === "function" &&
        value !== base &&
        Object.prototype.isPrototypeOf.call(base, value)
      ) {
        found.add(value as unknown as T);
        continue;
      }

      onSkipped?.(value, path);
    }
  }

  return [...found];
}

/**
 * The directory an app's `app/` sits in, as the running process can know it.
 *
 * `ROOT_DIR` is the obvious answer and is not available: `Server.start` awaits
 * `waitForBoot()` — every provider's `register` and `boot` — and only then
 * imports the http layer that sets it. Anything resolving paths during boot is
 * earlier than the variable it would want.
 *
 * What it can use is the same rule `httpProd` computes `ROOT_DIR` with a moment
 * later, which is why that file now calls this instead of repeating it. `gemi
 * dev` and `gemi start` both spawn the server with no `cwd`, so the process
 * inherits the CLI's, and the CLI takes `process.cwd()` for the project root
 * itself — `bun/preload.ts` reads `gemi.config` from it on the same assumption.
 *
 * `httpDev` computes a bare `process.cwd()`, so it and `httpProd` already
 * disagree whenever `GEMI_PROJECT_DIR` is set. Nothing in this repo sets it and
 * `gemi start` ignores it when locating the built entry point, so the two rules
 * are the same rule for every configuration that runs today; the divergence is
 * older than this function and wants its own fix.
 */
export function projectRoot(): string {
  return join(process.cwd(), process.env.GEMI_PROJECT_DIR ?? "");
}
