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
  const input = await createRollupInput();
  const rootDir = path.resolve(process.cwd());
  const appDir = path.join(rootDir, "app");

  console.log("Building client...");

  await $`GEMI_INPUT=${JSON.stringify(input)} vite build --outDir dist/client`;

  console.log("Building server...");
  try {
    process.env.GEMI_INPUT = JSON.stringify(input);
    await build({
      build: {
        ssr: true,
        outDir: "dist/server",
        rollupOptions: {
          input: "app/bootstrap.ts",
          external: ["bun", "react", "react-dom", "react/jsx-runtime", "gemi"],
        },
      },
      resolve: {
        alias: {
          "@/app": appDir,
        },
      },
    }).then(() => {
      console.log("Build succeeded");
    });
  } catch (err) {
    console.log(err);
  }
  process.exit();
});

program.command("start").action(async () => {
  process.env.NODE_ENV = "production";

  await $`echo "Starting server..."`;
  await startProdServer();
});

program.parse();
