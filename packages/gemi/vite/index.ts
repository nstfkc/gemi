import type { PluginOption } from "vite";

const gemi = (): PluginOption[] => {
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
  ];
};

export default gemi;
