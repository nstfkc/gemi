import path from "node:path";
import { defineConfig, mergeConfig } from "vite";

const rootDir = path.resolve(process.cwd());
const frameworkDir = path.join(rootDir, "framework");
const appDir = path.join(rootDir, "app");

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist/server",
    rollupOptions: {
      input: "framework/server/prod.ts",
      external: ["bun"],
    },
  },
  resolve: {
    alias: {
      "@/framework": frameworkDir,
      "@/app": appDir,
    },
  },
});
