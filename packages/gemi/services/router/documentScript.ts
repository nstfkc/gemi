import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../../support/discover";

/**
 * A static view's document script (#919): `.static({ script: "site/clicks" })`
 * inlines `app/views/site/clicks.script.ts`, bundled and minified, once in the
 * document's head.
 *
 * `gemi build` bundles every `app/views/**\/*.script.{ts,js}` into
 * `dist/server/document-scripts.json` (name → source), which `gemi start`
 * reads. Anywhere else (dev, a test through `app.fetch`) a script is bundled
 * from source on each use, so an edit shows on the next load.
 */

/** The suffix that marks a file under `app/views` as a document script. */
export const DOCUMENT_SCRIPT_SUFFIX = ".script";
const EXTENSIONS = [".ts", ".js"];
/** Under `dist/server`. */
export const DOCUMENT_SCRIPTS_MANIFEST = "document-scripts.json";
/** The attribute the inlined `<script>` carries, naming its script. */
export const DOCUMENT_SCRIPT_ATTRIBUTE = "data-gemi-script";

/** A name as `script` takes it: a path under `app/views`, without the suffix. */
const NAME = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

function assertName(name: string) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(
      `A static view's \`script\` is a path under app/views without the ".script.ts" suffix, e.g. "site/clicks". Got ${JSON.stringify(name)}.`,
    );
  }
}

/** The source file of `name` under `appDir`, or `null` when there is none. */
export function documentScriptFile(appDir: string, name: string): string | null {
  for (const extension of EXTENSIONS) {
    const file = join(appDir, "views", `${name}${DOCUMENT_SCRIPT_SUFFIX}${extension}`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Bundles one script for the browser: imports inlined, minified, wrapped in an
 * IIFE so nothing leaks into the page's scope. Throws when it does not bundle,
 * or when the output holds `</script` or `<!--`, which would end (or confuse)
 * the inline `<script>` element it is put in.
 */
export async function bundleDocumentScript(file: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [file],
    target: "browser",
    format: "iife",
    minify: true,
    throw: false,
  });
  if (!result.success || !result.outputs[0]) {
    const logs = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`The document script ${file} does not bundle.\n${logs}`);
  }
  const source = (await result.outputs[0].text()).trim();
  if (/<\/script|<!--/i.test(source)) {
    throw new Error(
      `The document script ${file} contains "</script" or "<!--", which would end the inline <script> it is put in. Write it "<\\/script" or build the string from parts.`,
    );
  }
  return source;
}

/** Every document script under `appDir/views`, bundled: what `gemi build` writes. */
export async function bundleDocumentScripts(appDir: string): Promise<Record<string, string>> {
  const views = join(appDir, "views");
  const scripts: Record<string, string> = {};
  if (!existsSync(views)) return scripts;
  const glob = new Bun.Glob(`**/*${DOCUMENT_SCRIPT_SUFFIX}.{ts,js}`);
  const files = [...glob.scanSync({ cwd: views })].sort();
  for (const file of files) {
    if (file.split("/").includes("node_modules")) continue;
    const name = file.replace(/\.script\.[tj]s$/, "");
    if (!NAME.test(name) || name in scripts) continue;
    scripts[name] = await bundleDocumentScript(join(views, file));
  }
  return scripts;
}

/** `'sha256-…'` of `source`, for a `script-src` directive. */
export function cspHashOf(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}

// `gemi start`'s manifest, read once. `undefined`: not read yet; `null`: none.
let built: Record<string, string> | null | undefined;
// Bundled from source in production when the manifest lacks a name: once.
const bundledInProduction = new Map<string, Promise<string>>();

function builtScripts(): Record<string, string> | null {
  if (built === undefined) {
    const file = join(projectRoot(), "dist", "server", DOCUMENT_SCRIPTS_MANIFEST);
    built = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  return built ?? null;
}

/** Forgets the manifest read by `documentScriptSource` (tests). @internal */
export function resetDocumentScripts() {
  built = undefined;
  bundledInProduction.clear();
}

/**
 * The inlined text of the document script `name`.
 *
 * In production, from `dist/server/document-scripts.json`. A name the
 * manifest lacks (or no manifest) is bundled from source once. Elsewhere it is
 * bundled from source each time. Throws when there is no such file.
 */
export async function documentScriptSource(name: string): Promise<string> {
  assertName(name);
  const production = process.env.NODE_ENV === "production";
  if (production) {
    const fromBuild = builtScripts()?.[name];
    if (fromBuild !== undefined) return fromBuild;
    const pending = bundledInProduction.get(name);
    if (pending) return pending;
  }
  const appDir = join(projectRoot(), "app");
  const file = documentScriptFile(appDir, name);
  if (!file) {
    throw new Error(
      `The document script "${name}" was not found. It is a file at app/views/${name}${DOCUMENT_SCRIPT_SUFFIX}.ts (or .js).`,
    );
  }
  if (!production) return bundleDocumentScript(file);
  const pending = bundleDocumentScript(file);
  bundledInProduction.set(name, pending);
  pending.catch(() => bundledInProduction.delete(name));
  return pending;
}

/**
 * `'sha256-…'` for the document script `name` exactly as a page inlines it,
 * for a `script-src` directive next to `STATIC_NAVIGATION_CSP_HASH`. In dev
 * it follows the source, so it changes as the file does.
 */
export async function documentScriptCspHash(name: string): Promise<string> {
  return cspHashOf(await documentScriptSource(name));
}
