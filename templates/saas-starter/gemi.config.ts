import { defineConfig } from "gemi/config";

export default defineConfig({
  // Vite plugins/config for the client + SSR view builds.
  // `plugins` are appended after gemi's own; any other key is a Vite UserConfig
  // field merged on top of gemi's defaults.
  vite: {
    plugins: [],
  },
  // Bun plugins applied to the server build and the dev/prod runtime.
  bun: {
    plugins: [],
  },
});
