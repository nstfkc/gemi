import { ModuleNode, type ViteDevServer } from "vite";

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

  let modules = new Set<ModuleNode>();
  for (const view of views) {
    const mod = vite.moduleGraph.getModulesByFile(view);
    if (mod) {
      modules = modules.union(mod);
    }
  }

  const styles = [];
  const cssModules = [];
  const cssModuleContent: Record<string, string> = {};
  for (const mod of modules as any) {
    if (mod) {
      for (const imported of mod.importedModules) {
        if (imported.file.includes("module.css")) {
          cssModuleContent[imported.file] =
            imported.ssrTransformResult.map.sourcesContent.join("");
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
        transform.default,
      );
    }

    styles.push({
      isDev: true,
      id: cssModulePath,
      content: isCssModule ? transformedCssModule : transform.code,
    });
  }

  return styles.map((style, i) => {
    return (
      <style key={i} type="text/css" data-vite-dev-id={style.id}>
        {style.content}
      </style>
    );
  });
}

export async function createStyles(styles = []) {
  return styles.map((style, i) => {
    return (
      <style key={i} id={style?.id} type="text/css">
        {style.content}
      </style>
    );
  });
}
