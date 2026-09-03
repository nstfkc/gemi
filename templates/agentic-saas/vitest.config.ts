import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the `@/app/*` path alias from tsconfig.json so tests can import
      // app modules the same way app code does.
      "@/app": resolve(__dirname, "app"),
    },
  },
});
