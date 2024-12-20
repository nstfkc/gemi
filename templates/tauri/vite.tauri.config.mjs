import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { execSync } from "child_process";

const host = process.env.TAURI_DEV_HOST;

function myPlugin() {
  const virtualModuleId = "virtual:gemi";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;

  return {
    name: "my-plugin", // required, will show up in warnings and errors
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },
    load(id) {
      const componentTreeBuffer = execSync("gemi app:component-tree", {
        cwd: process.cwd(),
      });
      const routeManifestBuffer = execSync("gemi app:route-manifest", {
        cwd: process.cwd(),
      });
      if (id === resolvedVirtualModuleId) {
        return `
          export const componentTree = ${componentTreeBuffer.toString()};
          export const routeManifest = ${routeManifestBuffer.toString()};
        `;
      }
    },
  };
}

export default defineConfig({
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  plugins: [myPlugin(), react()],
  resolve: {
    alias: {
      "@/app": `${process.cwd()}/app`,
    },
  },
});
