import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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
  let text: string;
  try {
    text = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The prompt "${name}" does not exist (looked for ${path}).`);
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
   * Each call replaces the previous options and clears the cache.
   */
  static configure(next: PromptOptions) {
    options = { ...next };
    files.clear();
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
