import { $ } from "bun";

import { startDevServer } from "../server/dev";
import createRollupInput from "./createRollupInput";

import { program } from "commander";

program.command("dev").action(async () => {
  await startDevServer();
});

program.command("build").action(async () => {
  await createRollupInput();
  console.log("Building...");
});

program.command("start").action(async () => {
  await $`echo "Starting server..."`;
});

program.parse();
