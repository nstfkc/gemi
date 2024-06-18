import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import input from "./.gemi/rollupInput.json";

const rootDir = path.resolve(process.cwd());
const appDir = path.join(rootDir, "app");

export default defineConfig({
  plugins: [react()],
  assetsInclude: ["/public"],
  build: {
    manifest: true,
    rollupOptions: {
      input,
    },
    ssrEmitAssets: true,
  },
  resolve: {
    alias: {
      "@/app": appDir,
    },
  },
});
