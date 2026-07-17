import type { PluginOption } from "vite";
import { loadGemiConfig } from "../config/load";

// Async so it can load `gemi.config.ts` before returning the plugin list. The
// build runs Vite under `bun --bun` and dev under `bun --hot`, so the config's
// TypeScript imports directly. Vite accepts a `Promise<PluginOption[]>` as an
// entry in its `plugins` array, so `plugins: [react(), gemi()]` keeps working.
const gemi = async (): Promise<PluginOption[]> => {
  const userConfig = await loadGemiConfig(process.cwd());
  const { plugins: userVitePlugins = [], ...userViteConfig } =
    userConfig.vite ?? {};

  return [
    {
      name: "gemi-plugin-config",
      enforce: "pre",
      config: async (_config, env) => {
        const appPath = `${process.cwd()}/app`;
        return {
          assetsInclude: ["/public"],
          build: {
            manifest: true,
            ssrEmitAssets: true,
            // Emit source maps for both the client and SSR view builds so
            // browser devtools and server stack traces map back to app source.
            sourcemap: true,
            rollupOptions: {
              input: Array.from(JSON.parse(process.env.GEMI_INPUT ?? "[]")),
              // For the SSR build, externalize `gemi` (a linked package) and all
              // its subpaths. Otherwise the bundler compiles its own copy of
              // gemi's module-level singletons (`RouteStateContext`,
              // `I18nContext`, the `useLocale`/`useRouteData` hooks, ...) into a
              // shared chunk — a *different* instance than the running server's
              // `Root` provider — so `useRouteData()` reads the empty default and
              // SSR crashes on `i18n.currentLocale`. Externalizing makes the
              // built view chunks `import ... from "gemi/*"` at runtime, resolving
              // to the one instance shared with the renderer. (Vite 8's
              // `ssr.external` does not externalize for the build, so this is done
              // at the rollup level.) Mirrors `server2/httpDev.ts`'s dev config.
              ...(env.isSsrBuild
                ? {
                    external: (id: string) =>
                      id === "gemi" || id.startsWith("gemi/"),
                  }
                : {}),
            },
          },
          resolve: {
            alias: {
              "@/app": appPath,
            },
          },
        };
      },
    },
    // The app's `gemi.config.ts` `vite` config (minus `plugins`, which are
    // appended below) as its own `config` hook. Vite deep-merges every plugin's
    // `config` result, so the app config layers cleanly on top of gemi's base
    // without a manual merge (and without pulling `vite`'s `mergeConfig` into
    // this bundle).
    {
      name: "gemi-plugin-user-config",
      config: () => userViteConfig,
    },
    {
      name: "gemi-plugin-hot-reload",
      handleHotUpdate({ server, modules }) {
        if (modules?.[0]?.id?.includes("/app/http/")) {
          // server.ws.send({
          //   type: "custom",
          //   event: "http-reload",
          //   data: {
          //     id: modules[0].id,
          //   },
          // });

          return [];
        }
      },
    },
    // App-provided Vite plugins run after gemi's own.
    ...userVitePlugins,
  ];
};

export default gemi;
