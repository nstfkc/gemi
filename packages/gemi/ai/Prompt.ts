import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { projectRoot } from "../support/discover";

/**
 * The file `gemi build` writes under `dist/server`: every Markdown file under `app/agents`,
 * keyed by its path from the project root (`app/agents/siteNamer/name.md`).
 * @internal
 */
export const PROMPTS_MANIFEST = "prompts.json";

/**
 * The values a prompt's `{{placeholders}}` are filled from.
 */
export type PromptValues = Record<string, string | number>;

export interface PromptOptions {
  /**
   * The folder prompt names resolve under, relative to the working directory
   * (or absolute). Default `app/agents`: `siteNamer/name` is
   * `app/agents/siteNamer/name.md`, so a prompt can live beside its agent.
   */
  dir?: string;
  /**
   * The folder under `dir` that a bare name (no `/`) resolves in. Default
   * `prompts`: `copy-guide` is `app/agents/prompts/copy-guide.md`.
   */
  shared?: string;
  /**
   * Keep each file after its first read. Default: on when `NODE_ENV` is
   * `production`, off otherwise, so an edited prompt is read again in dev.
   */
  cache?: boolean;
}

// A partial is `{{> name}}`; a placeholder is `{{name}}`. Neither allows
// spaces inside the name's braces, so the `{{ ... }}` of a JSX style object or
// a template-language example in a prompt is left as it is.
const PARTIAL = /\{\{>\s*([\w./-]+)\s*\}\}/g;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const NAME = /^[\w-]+(\/[\w-]+)*$/;

const defaults = { dir: "app/agents", shared: "prompts" };
let options: PromptOptions = {};
const files = new Map<string, string>();
// `gemi build`'s manifest, read once. `undefined`: not read yet; `null`: none.
let built: Record<string, string> | null | undefined;

function builtPrompts(): Record<string, string> | null {
  if (built === undefined) {
    const file = join(projectRoot(), "dist", "server", PROMPTS_MANIFEST);
    built = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  return built ?? null;
}

function trimFinalNewline(text: string) {
  return text.replace(/\r?\n$/, "");
}

/**
 * Every prompt file under `rootDir/app/agents`, keyed by its path from
 * `rootDir`: what `gemi build` writes to `dist/server/prompts.json`, so
 * `gemi start` renders prompts from an image that ships no `app/` source.
 * @internal
 */
export function bundlePrompts(rootDir: string): Record<string, string> {
  const prompts: Record<string, string> = {};
  const agents = join(rootDir, defaults.dir);
  if (!existsSync(agents)) return prompts;
  const found = readdirSync(agents, { recursive: true, encoding: "utf8" });
  for (const file of found.sort()) {
    if (!file.endsWith(".md") || file.split(sep).includes("node_modules")) continue;
    const key = [defaults.dir, ...file.split(sep)].join("/");
    prompts[key] = trimFinalNewline(readFileSync(join(agents, file), "utf8"));
  }
  return prompts;
}

function caching() {
  return options.cache ?? process.env.NODE_ENV === "production";
}

function pathOf(name: string) {
  if (!NAME.test(name)) {
    throw new Error(
      `"${name}" is not a prompt name. Use letters, digits, "-" and "_", with "/" between folders.`,
    );
  }
  const dir = options.dir ?? defaults.dir;
  const root = isAbsolute(dir) ? dir : join(process.cwd(), dir);
  const file = name.includes("/")
    ? `${name}.md`
    : join(options.shared ?? defaults.shared, `${name}.md`);
  return join(root, file);
}

function read(name: string) {
  const path = pathOf(name);
  const cached = caching() ? files.get(path) : undefined;
  if (cached !== undefined) return cached;
  const production = process.env.NODE_ENV === "production";
  if (production) {
    const fromBuild = builtPrompts()?.[relative(projectRoot(), path).split(sep).join("/")];
    if (fromBuild !== undefined) return fromBuild;
  }
  let text: string;
  try {
    text = trimFinalNewline(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const manifest = production ? ` or in dist/server/${PROMPTS_MANIFEST}` : "";
      throw new Error(`The prompt "${name}" does not exist (looked for ${path}${manifest}).`);
    }
    throw error;
  }
  if (caching()) files.set(path, text);
  return text;
}

function expand(name: string, stack: string[]): string {
  if (stack.includes(name)) {
    throw new Error(`The prompt "${name}" includes itself: ${[...stack, name].join(" > ")}.`);
  }
  return read(name).replace(PARTIAL, (_, partial: string) => expand(partial, [...stack, name]));
}

/**
 * Markdown prompt files with `{{placeholders}}`.
 *
 * ```ts
 * import { Prompt } from "gemi/ai";
 *
 * // app/agents/siteNamer/name.md: "Name a site for {{business}}. {{> shared/tone}}"
 * Prompt.render("siteNamer/name", { business: "a bakery" });
 * ```
 */
export class Prompt {
  /**
   * Change where prompts are read from, or whether they are cached. Call it
   * once at boot (a service provider, `app/preload.ts`, a test setup file).
   * Each call replaces the previous options and clears the cache (and forgets
   * the `gemi build` manifest, which is read again on the next render).
   */
  static configure(next: PromptOptions) {
    options = { ...next };
    files.clear();
    built = undefined;
  }

  /**
   * The prompt `name`, its partials (`{{> other/name}}`) included and its
   * `{{placeholders}}` filled from `values`, without the file's final newline.
   *
   * A name with a `/` is a path under `dir` (`siteNamer/name`); a bare name is
   * a shared prompt (`copy-guide` is `prompts/copy-guide.md`). Partials resolve
   * the same way and share `values`.
   *
   * Throws when the file (or a partial) is missing, a partial includes itself,
   * or a placeholder has no value, so a prompt never reaches the model with a
   * `{{placeholder}}` left in it. A value no placeholder uses is ignored.
   */
  static render(name: string, values: PromptValues = {}): string {
    return expand(name, []).replace(PLACEHOLDER, (_, key: string) => {
      if (!Object.hasOwn(values, key)) {
        throw new Error(`The prompt "${name}" has no value for {{${key}}}.`);
      }
      return String(values[key]);
    });
  }

  /**
   * The placeholder names `name` uses, its partials included, in order of
   * first use. For a test that checks a caller passes every value.
   */
  static placeholders(name: string): string[] {
    const keys = [...expand(name, []).matchAll(PLACEHOLDER)].map((match) => match[1]);
    return [...new Set(keys)];
  }
}
