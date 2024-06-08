import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import input from "./rollupInput";

const rootDir = path.resolve(process.cwd());
const frameworkDir = path.join(rootDir, "framework");
const appDir = path.join(rootDir, "app");

export default defineConfig({
  plugins: [react()],
  assetsInclude: ["/public"],
  build: {
    manifest: true,
    rollupOptions: {
      input: "app/client.tsx",
    },
    ssrEmitAssets: true,
  },
  resolve: {
    alias: {
      "@/framework": frameworkDir,
      "@/app": appDir,
    },
  },
});
