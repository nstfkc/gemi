import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export async function input() {
  const root = process.cwd();
  const inputPath = join(root, ".gemi/rollupInput.json");
  if (!existsSync(inputPath)) {
    return ["app/main.tsx"];
  }
  const json = readFileSync(inputPath).toJSON();
  return json;
}
