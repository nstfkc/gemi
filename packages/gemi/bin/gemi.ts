import { $ } from "bun";

import path from "node:path";
import { startDevServer } from "../server/dev";
import { startProdServer } from "../server/prod";
import createRollupInput from "./createRollupInput";
import { build } from "vite";

import { program } from "commander";

program.command("dev").action(async () => {
  console.log("Starting dev server...");
  await startDevServer();
});

program.command("build").action(async () => {
  process.env.NODE_ENV = "production";
  await createRollupInput();
  const rootDir = path.resolve(process.cwd());
  const appDir = path.join(rootDir, "app");

  console.log("Building client...");
  await $`vite build --outDir dist/client`;

  console.log("Building server...");
  try {
    await build({
      build: {
        ssr: true,
        outDir: "dist/server",
        rollupOptions: {
          input: "app/bootstrap.ts",
          external: ["bun", "react", "react-dom", "gemi"],
        },
      },
      resolve: {
        alias: {
          "@/app": appDir,
        },
      },
    });
  } catch (err) {
    console.log(err);
  }
  await $`exit 0`;
});

program.command("start").action(async () => {
  process.env.NODE_ENV = "production";

  await $`echo "Starting server..."`;
  await startProdServer();
});

program.parse();
