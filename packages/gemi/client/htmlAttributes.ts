import type { HtmlAttributes } from "../http/Metadata";

export type { HtmlAttributes };

// Languages written right to left, by their primary subtag.
const RTL_LANGUAGES = new Set(["ar", "arc", "ckb", "dv", "fa", "he", "iw", "ks", "ps", "sd", "ug", "ur", "yi"]);

/** The direction `lang` is written in: `"rtl"` for Arabic, Hebrew and the like, else `"ltr"`. */
export function textDirection(lang: string | null | undefined): "ltr" | "rtl" {
  const language = lang?.split(/[-_]/)[0]?.toLowerCase() ?? "";
  return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}

/**
 * The `<html>` attributes a layout receives: what the response set with
 * `Meta.htmlAttributes`, else the request's locale and its direction.
 */
export function resolveHtmlAttributes(
  set: HtmlAttributes | null | undefined,
  locale: string | null | undefined,
): Required<Pick<HtmlAttributes, "lang" | "dir">> & HtmlAttributes {
  const lang = set?.lang ?? locale ?? "en";
  return { ...set, lang, dir: set?.dir ?? textDirection(lang) };
}

/** The props gemi renders a root layout (or a static view's layout) with. */
export interface RootLayoutProps {
  children: React.ReactNode;
  /** The request's locale; empty when the app configures none. */
  locale: string;
  /** For `<html {...htmlAttributes}>`: `lang` and `dir`, see `Meta.htmlAttributes`. */
  htmlAttributes: ReturnType<typeof resolveHtmlAttributes>;
}
