import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import gemi from "gemi/vite";

export default defineConfig({
  plugins: [react(), gemi()],
});
