import path from "node:path";
import { defineConfig, mergeConfig } from "vite";

const rootDir = path.resolve(process.cwd());
const appDir = path.join(rootDir, "app");

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist/server",
    rollupOptions: {
      input: "prod.ts",
      external: ["bun"],
    },
  },
  resolve: {
    alias: {
      "@/app": appDir,
    },
  },
});
