import type { PluginOption } from "vite";
import { customRequestParser } from "./customRequestParser";

const gemi = (): PluginOption[] => {
  return [
    {
      name: "gemi-plugin-config",
      enforce: "pre",
      config: async () => {
        const appPath = `${process.cwd()}/app`;
        return {
          assetsInclude: ["/public"],
          build: {
            manifest: true,
            ssrEmitAssets: true,
            rollupOptions: {
              input: Array.from(JSON.parse(process.env.GEMI_INPUT ?? "[]")),
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
        if (modules[0].id.includes("/app/http/")) {
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
    {
      name: "gemi-plugin-custom-request",
      enforce: "pre",
      async transform(src, id) {
        if (id.includes("/http/controllers/") || id.includes("/http/routes/")) {
          const code = await customRequestParser(src);
          return {
            code,
          };
        }
      },
    },
  ];
};

export default gemi;
