import MagicString from "magic-string";
import { parseAstAsync, type Plugin } from "vite";
import {
  dictionaryId,
  dictionaryLocales,
  localeStrings,
  type DictionaryTranslations,
} from "../i18n/dictionaryShape";

/**
 * Splits `defineDictionary({...})` literals into one chunk per locale.
 *
 * Authoring keeps every locale in one file next to the component. This rewrites
 * the call so the strings themselves leave the module entirely:
 *
 *   const dict = defineDictionary({ title: { "en-US": "Hi", "tr-TR": "Selam" } })
 *
 * becomes
 *
 *   const dict = __gemi_dict__("d_1a2b3c4d5e6f7081", {
 *     "en-US": () => import("virtual:gemi-dict/<src>/d_.../en-US"),
 *     "tr-TR": () => import("virtual:gemi-dict/<src>/d_.../tr-TR"),
 *   })
 *
 * An explicit map rather than a template-literal `import()`: the bundler sees
 * static specifiers, so it emits a real chunk per locale and module-preload
 * hints keep working. A page then downloads only the locale it renders in.
 *
 * This is purely an optimization. `defineDictionary` untransformed holds every
 * locale and answers synchronously, which is what keeps `bun test` and server
 * code that never meets the bundler working with no special casing.
 */

const VIRTUAL_PREFIX = "virtual:gemi-dict/";
const RESOLVED_PREFIX = "\0virtual:gemi-dict/";

/** Entrypoints that may export `defineDictionary`. */
const DICTIONARY_SOURCES = new Set(["gemi/dictionary", "gemi/client", "gemi/i18n"]);

/** Where the rewritten call reads `__gemi_dict__` from.
 *
 * `gemi/dictionary` is a deliberately tiny entrypoint holding only the registry
 * and the handle factory: it is in `GEMI_EXTERNAL_SPECIFIERS`, so under SSR it
 * resolves to the server's own instance and the registry the view router
 * preloads through is the same one the views register into. Pointing this at a
 * bundled copy instead would give the server two registries.
 */
const RUNTIME_SOURCE = "gemi/dictionary";

interface Extracted {
  /** The runtime id — a content hash, identical to what `defineDictionary`
   * computes for the same literal, which is what lets the SSR payload seed the
   * client registry. */
  id: string;
  locales: string[];
  translations: DictionaryTranslations;
}

export function gemiDictionaryPlugin(): Plugin {
  // virtual key -> extracted dictionary, populated by `transform` and read by
  // `load`. Keyed by the virtual key rather than the runtime id because the key
  // also carries the source module, which is what lets a cold `load` recover.
  //
  // Ordering holds in every mode: a bundler resolves a module's imports only
  // after transforming it, and the virtual specifiers do not exist until this
  // transform writes them. Vite keeps one plugin instance for the life of the
  // dev server (gemi reuses a single Vite instance across `bun --hot` reloads),
  // so the map outlives individual requests.
  const extracted = new Map<string, Extracted>();

  return {
    name: "gemi-plugin-dictionary",
    // After TS and JSX have been stripped: `parseAstAsync` is a JavaScript
    // parser, so this must not run `pre`.
    enforce: "post",

    resolveId(id) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        return `\0${id}`;
      }
      return null;
    },

    async load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) {
        return null;
      }

      const rest = id.slice(RESOLVED_PREFIX.length);
      const slash = rest.lastIndexOf("/");
      const virtualKey = rest.slice(0, slash);
      const locale = rest.slice(slash + 1);

      let entry = extracted.get(virtualKey);
      if (!entry) {
        // The parent module was transformed by an earlier process (a warm
        // on-disk cache) so this map never saw it. Force the parent back
        // through the pipeline, which repopulates the entry.
        const sourceId = decodeSourceId(virtualKey);
        if (sourceId) {
          try {
            await this.load({ id: sourceId });
          } catch {
            // Fall through to the error below, which says something useful.
          }
          entry = extracted.get(virtualKey);
        }
      }

      if (!entry) {
        this.error(
          `No dictionary registered for "${virtualKey}". If this persists, restart the dev server.`,
        );
        return null;
      }

      const strings = localeStrings(entry.translations, locale, entry.locales);
      return `export default ${JSON.stringify(strings)};\n`;
    },

    async transform(code, id) {
      // Cheap gate — most modules never mention it.
      if (!code.includes("defineDictionary")) {
        return null;
      }
      if (id.startsWith("\0") || id.includes("/node_modules/")) {
        return null;
      }

      const ast = await parseAstAsync(code);

      const localNames = new Set<string>();
      for (const node of ast.body as any[]) {
        if (node.type !== "ImportDeclaration") continue;
        if (!DICTIONARY_SOURCES.has(node.source?.value)) continue;
        for (const spec of node.specifiers ?? []) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported?.name === "defineDictionary"
          ) {
            localNames.add(spec.local.name);
          }
        }
      }
      if (localNames.size === 0) {
        return null;
      }

      const calls: any[] = [];
      walk(ast, (node) => {
        if (
          node.type === "CallExpression" &&
          node.callee?.type === "Identifier" &&
          localNames.has(node.callee.name)
        ) {
          calls.push(node);
        }
      });
      if (calls.length === 0) {
        return null;
      }

      const s = new MagicString(code);
      let rewrote = false;

      for (const call of calls) {
        if (call.arguments?.length !== 1) {
          this.error({
            message: `defineDictionary() takes exactly one object literal.`,
            pos: call.start,
          });
        }

        const translations = readObjectLiteral(call.arguments[0], (message) =>
          this.error({ message, pos: call.arguments[0]?.start ?? call.start }),
        );

        const runtimeId = dictionaryId(translations);
        const virtualKey = `${Buffer.from(id).toString("base64url")}/${runtimeId}`;
        const locales = dictionaryLocales(translations);

        if (locales.length === 0) {
          this.error({
            message: `defineDictionary() declares no locales — every key needs at least one "<locale>": "<string>" entry.`,
            pos: call.start,
          });
        }

        extracted.set(virtualKey, { id: runtimeId, locales, translations });

        const loaders = locales
          .map(
            (locale) =>
              `${JSON.stringify(locale)}:()=>import(${JSON.stringify(
                `${VIRTUAL_PREFIX}${virtualKey}/${locale}`,
              )})`,
          )
          .join(",");

        s.overwrite(
          call.start,
          call.end,
          `__gemi_dict__(${JSON.stringify(runtimeId)},{${loaders}})`,
        );
        rewrote = true;
      }

      if (!rewrote) {
        return null;
      }

      // Appended, not prepended: an `import` declaration is hoisted wherever it
      // sits, and keeping it off the top leaves every original line where it
      // was for the sourcemap.
      s.append(
        `\nimport { __gemi_dict__ } from ${JSON.stringify(RUNTIME_SOURCE)};\n`,
      );

      return { code: s.toString(), map: s.generateMap({ hires: true }) };
    },
  };
}

/**
 * The virtual key carries the source module alongside the content hash, so a
 * cold `load` can find its way back to the module that declared it.
 */
function decodeSourceId(virtualKey: string): string | null {
  const slash = virtualKey.indexOf("/");
  if (slash === -1) return null;
  try {
    return Buffer.from(virtualKey.slice(0, slash), "base64url").toString(
      "utf8",
    );
  } catch {
    return null;
  }
}

/**
 * A dictionary has to be readable at build time, so the literal must be fully
 * static. Anything else fails the build with the offending key named — a silent
 * fallback to "leave this one un-split" would ship every locale to the browser
 * and nobody would notice.
 */
function readObjectLiteral(
  node: any,
  fail: (message: string) => never,
): DictionaryTranslations {
  if (node?.type !== "ObjectExpression") {
    fail(
      `defineDictionary() needs an inline object literal — it is read at build time, so a variable or spread cannot be resolved.`,
    );
  }

  const out: DictionaryTranslations = {};
  for (const prop of node.properties) {
    const key = propertyName(prop);
    if (key === null) {
      fail(
        `defineDictionary() keys must be plain string keys — computed keys and spreads cannot be read at build time.`,
      );
    }
    if (prop.value?.type !== "ObjectExpression") {
      fail(
        `defineDictionary() entry "${key}" must be an object of "<locale>": "<string>" pairs.`,
      );
    }

    const byLocale: Record<string, string> = {};
    for (const localeProp of prop.value.properties) {
      const locale = propertyName(localeProp);
      if (locale === null) {
        fail(
          `defineDictionary() entry "${key}" has a locale key that cannot be read at build time.`,
        );
      }
      const value = localeProp.value;
      if (value?.type !== "Literal" || typeof value.value !== "string") {
        fail(
          `defineDictionary() entry "${key}" locale "${locale}" must be a string literal. Use {{param}} interpolation instead of a template literal or a function.`,
        );
      }
      byLocale[locale] = value.value;
    }
    out[key] = byLocale;
  }
  return out;
}

function propertyName(prop: any): string | null {
  if (prop?.type !== "Property" || prop.computed) return null;
  if (prop.key?.type === "Identifier") return prop.key.name;
  if (prop.key?.type === "Literal" && typeof prop.key.value === "string") {
    return prop.key.value;
  }
  return null;
}

/** Minimal ESTree walk — enough to find call expressions, no extra dependency. */
function walk(node: any, visit: (node: any) => void) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") {
    visit(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = (node as any)[key];
    if (value && typeof value === "object") {
      walk(value, visit);
    }
  }
}
