import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectRoot } from "../support/discover";

/**
 * Browser probes (#1020): code an app runs in a headless browser's page with
 * `page.evaluate`, written as a normal module.
 *
 * `page.evaluate` sends one function's source to the browser, so it may use
 * nothing from outside itself. A probe is a module under `app/` named
 * `*.probe.ts` (or `.js`) whose default export is the function to run; it can
 * import helpers like any module. gemi bundles it into one self-contained,
 * minified IIFE for the browser and hands it to `page.evaluate` as an
 * expression that calls the default export with the given arguments.
 *
 * `gemi build` bundles every probe into `dist/server/probes.json` (name →
 * source), which `gemi start` reads. Anywhere else (dev, tests) a probe is
 * bundled on first use and kept until it, or a file it imports, changes.
 *
 * A probe is named by its path under `app/` without the suffix:
 * `app/utils/layout.probe.ts` is `"utils/layout"`.
 */

/** The suffix that marks a file under `app` as a probe. */
export const PROBE_SUFFIX = ".probe";
const EXTENSIONS = [".ts", ".js"];
/** Under `dist/server`. */
export const PROBES_MANIFEST = "probes.json";

/** The free name the bundled IIFE hands the default export to. */
const DEFINE = "__gemiProbe__";
/** The bundle's entry: imports the probe and hands its default export over. */
const ENTRY = "/__gemi_probe_entry__.ts";

/** A name as `probe` takes it: a path under `app`, without the suffix. */
const NAME = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

function assertName(name: string) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(
      `A probe is named by its path under app/ without the ".probe.ts" suffix, e.g. "utils/layout". Got ${JSON.stringify(name)}.`,
    );
  }
}

/** The source file of the probe `name` under `appDir`, or `null` when there is none. */
export function probeFile(appDir: string, name: string): string | null {
  for (const extension of EXTENSIONS) {
    const file = join(appDir, `${name}${PROBE_SUFFIX}${extension}`);
    if (existsSync(file)) return file;
  }
  return null;
}

type Bundled = {
  /** The IIFE: hands the probe's default export to `__gemiProbe__`. */
  source: string;
  /** Every file the bundle read, absolute, for the dev cache. */
  inputs: string[];
};

/**
 * Bundles one probe for the browser: imports inlined, minified, wrapped in an
 * IIFE that hands the default export to `__gemiProbe__`. Throws when it does
 * not bundle.
 */
async function bundle(file: string): Promise<Bundled> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    files: {
      [ENTRY]: `import probe from ${JSON.stringify(file)};\n${DEFINE}(probe);\n`,
    },
    target: "browser",
    format: "iife",
    minify: true,
    metafile: true,
    throw: false,
  });
  if (!result.success || !result.outputs[0]) {
    const logs = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`The probe ${file} does not bundle.\n${logs}`);
  }
  const inputs = Object.keys(result.metafile?.inputs ?? {})
    .map((input) => resolve(input))
    .filter((input) => input !== ENTRY && existsSync(input));
  return { source: (await result.outputs[0].text()).trim(), inputs };
}

/** One probe's bundled source (the IIFE). Throws when it does not bundle. */
export async function bundleProbe(file: string): Promise<string> {
  return (await bundle(file)).source;
}

/** Every probe under `appDir`, bundled: what `gemi build` writes. */
export async function bundleProbes(appDir: string): Promise<Record<string, string>> {
  const probes: Record<string, string> = {};
  if (!existsSync(appDir)) return probes;
  const glob = new Bun.Glob(`**/*${PROBE_SUFFIX}.{ts,js}`);
  const files = [...glob.scanSync({ cwd: appDir })].sort();
  for (const file of files) {
    if (file.split("/").includes("node_modules")) continue;
    const name = file.replace(/\.probe\.[tj]s$/, "");
    if (!NAME.test(name) || name in probes) continue;
    probes[name] = await bundleProbe(join(appDir, file));
  }
  return probes;
}

// `gemi start`'s manifest, read once. `undefined`: not read yet; `null`: none.
let built: Record<string, string> | null | undefined;
// Bundled from source: in production once, elsewhere until an input changes.
type Cached = { pending: Promise<Bundled>; stamps: Map<string, number> | null };
const cache = new Map<string, Cached>();

function builtProbes(): Record<string, string> | null {
  if (built === undefined) {
    const file = join(projectRoot(), "dist", "server", PROBES_MANIFEST);
    built = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  return built ?? null;
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function stale(stamps: Map<string, number>): boolean {
  for (const [file, mtime] of stamps) {
    if (mtimeOf(file) !== mtime) return true;
  }
  return false;
}

/** Forgets the manifest and every bundled probe (tests). @internal */
export function resetProbes() {
  built = undefined;
  cache.clear();
}

/**
 * The bundled source (an IIFE) of the probe `name`.
 *
 * In production, from `dist/server/probes.json`; a name the manifest lacks
 * (or no manifest) is bundled from source once. Elsewhere it is bundled on
 * first use and again only once the probe or a file it imports has changed.
 * Throws when there is no such file or it does not bundle.
 */
export async function probeSource(name: string): Promise<string> {
  assertName(name);
  const production = process.env.NODE_ENV === "production";
  if (production) {
    const fromBuild = builtProbes()?.[name];
    if (fromBuild !== undefined) return fromBuild;
  }
  const cached = cache.get(name);
  if (cached && (cached.stamps === null || !stale(cached.stamps))) {
    return (await cached.pending).source;
  }
  const file = probeFile(join(projectRoot(), "app"), name);
  if (!file) {
    throw new Error(
      `The probe "${name}" was not found. It is a file at app/${name}${PROBE_SUFFIX}.ts (or .js).`,
    );
  }
  const startedAt = Date.now();
  const entry: Cached = { pending: bundle(file), stamps: null };
  cache.set(name, entry);
  try {
    const bundled = await entry.pending;
    if (!production) {
      // A file changed while it bundled may not be in the bundle: such a
      // stamp never matches, so the next use bundles again.
      entry.stamps = new Map(
        bundled.inputs.map((input) => {
          const mtime = mtimeOf(input);
          return [input, mtime >= startedAt ? -2 : mtime];
        }),
      );
    }
    return bundled.source;
  } catch (error) {
    if (cache.get(name) === entry) cache.delete(name);
    throw error;
  }
}

/**
 * A JavaScript expression that runs the bundled probe `source` with `args`
 * and evaluates to what it returns (a promise, for an async probe).
 */
export function probeExpression(source: string, args: readonly unknown[]): string {
  const json = JSON.stringify(args);
  if (json === undefined) throw new Error("A probe's arguments must be JSON values.");
  // The local names start with `__gemi` so they shadow none of the page's globals the bundle may use.
  return `(() => { let __gemiProbeFn__; const ${DEFINE} = (fn) => { __gemiProbeFn__ = fn; }; ${source}; return __gemiProbeFn__(...${json}); })()`;
}

/** Anything that evaluates an expression in a page: a puppeteer or playwright `Page`. */
export interface ProbePage {
  evaluate(expression: string): Promise<unknown>;
}

/** The probe function, from its module's type or its own. */
type ProbeFunctionOf<M> = M extends { default: infer F } ? F : M;
type AnyFunction = (...args: any[]) => unknown;
type ArgsOf<F> = F extends AnyFunction ? Parameters<F> : never;
type ResultOf<F> = F extends AnyFunction ? Awaited<ReturnType<F>> : never;

export class Probe<M = AnyFunction> {
  constructor(readonly name: string) {
    assertName(name);
  }

  /** The bundled IIFE. */
  source(): Promise<string> {
    return probeSource(this.name);
  }

  /**
   * An expression that runs the probe with `args`, for a driver that takes a
   * script string. The arguments must be JSON values.
   */
  async expression(...args: ArgsOf<ProbeFunctionOf<M>>): Promise<string> {
    return probeExpression(await this.source(), args);
  }

  /** Runs the probe in `page` with `args` and returns its (awaited) result. */
  async run(page: ProbePage, ...args: ArgsOf<ProbeFunctionOf<M>>): Promise<ResultOf<ProbeFunctionOf<M>>> {
    return (await page.evaluate(await this.expression(...args))) as ResultOf<ProbeFunctionOf<M>>;
  }
}

/**
 * The probe at `app/<name>.probe.ts`, typed by its module:
 *
 * ```ts
 * const readLayout = probe<typeof import("@/app/utils/layout.probe")>("utils/layout");
 * const reading = await readLayout.run(page, sections);
 * ```
 */
export function probe<M = AnyFunction>(name: string): Probe<M> {
  return new Probe<M>(name);
}
