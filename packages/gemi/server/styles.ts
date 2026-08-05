import { createElement } from "react";
import { type ModuleNode, type ViteDevServer } from "vite";

function replaceStrings(text: string, record: Record<string, string>): string {
  const escapedKeys = Object.keys(record)
    .sort((a, b) => b.length - a.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  // Create a single regex with all keys
  const regex = new RegExp(escapedKeys.join("|"), "g");

  return text.replace(regex, (match) => record[match]);
}

export async function createDevStyles(
  appDir: string,
  vite: ViteDevServer,
  currentViews: string[] = [],
) {
  const views = [
    ...currentViews.map((view) => `${appDir}/views/${view}.tsx`),
    `${appDir}/views/RootLayout.tsx`,
  ];

  const modules = new Set<ModuleNode>();
  for (const view of views) {
    const mod = vite.moduleGraph.getModulesByFile(view);
    if (mod) {
      for (const m of mod) modules.add(m);
    }
  }

  const styles = [];
  const cssModules = [];
  const cssModuleContent: Record<string, string> = {};
  for (const mod of modules as any) {
    if (mod) {
      for (const imported of mod.importedModules) {
        if (imported.file.includes("module.css")) {
          cssModuleContent[imported.file] = imported.ssrTransformResult.map.sourcesContent.join("");
        }
        if (imported.file.includes(".css")) {
          cssModules.push(imported.file);
        }
      }
    }
  }

  for (const cssModulePath of cssModules) {
    const transform = await vite.transformRequest(cssModulePath + "?direct");

    const isCssModule = cssModulePath.includes("module.css");

    let transformedCssModule = "";

    if (isCssModule) {
      transformedCssModule = replaceStrings(
        cssModuleContent[cssModulePath],
        // Vite's `TransformResult` type has no `default`, but the CSS-module
        // transform attaches the class-name mapping there at runtime.
        (transform as unknown as { default: Record<string, string> }).default,
      );
    }

    styles.push({
      isDev: true,
      id: cssModulePath,
      content: isCssModule ? transformedCssModule : transform.code,
    });
  }

  return styles.map(hoistable);
}

export async function createStyles(styles = []) {
  return styles.map(hoistable);
}

/**
 * The precedence every gemi-emitted stylesheet is hoisted under. One shared
 * name on purpose: React keeps same-precedence styles in a single tag in
 * insertion order, which is the order the split assumes — the app bundle
 * first, then the route's own CSS layered over it.
 */
const STYLE_PRECEDENCE = "gemi";

/**
 * A `<style>` React 19 will lift into `<head>` and block the first paint on.
 *
 * It only does that when the tag carries both `precedence` and `href` (the
 * dedupe key). Without them the tag stays where it was rendered, and these are
 * rendered as siblings *before* `<html>` — so React normalizes them into
 * `<body>`, nothing in `<head>` is render-blocking, and the browser paints the
 * whole document unstyled before the CSS applies (#328).
 *
 * React strips every other attribute off a hoisted style, `id` and
 * `data-vite-dev-id` included, and leaves only `data-precedence` +
 * `data-href`. `fetchRouteCSS` reads that `data-href` list to tell what is
 * already on the page; nothing reads the dev id, and Vite re-injects its own
 * tag for HMR rather than adopting this one.
 */
function hoistable(style: { id: string; content: string }, i: number) {
  return createElement("style", {
    key: i,
    href: style.id,
    precedence: STYLE_PRECEDENCE,
    dangerouslySetInnerHTML: { __html: style.content },
  });
}
