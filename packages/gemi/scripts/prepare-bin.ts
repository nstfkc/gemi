import { join } from "path";
import { chmod } from "fs/promises";

// Every entry in package.json's `bin` map. Both are spawned as processes by
// something other than the shell that built them — `gemi` by npm/bun through
// node_modules/.bin, and `orm-generator` by the Prisma CLI over stdio — so both
// need a shebang and an executable bit or the spawn fails with a confusing
// "exec format error".
const BIN_FILES = ["gemi.js", "orm-generator.js"];

const SHEBANG = "#!/usr/bin/env bun\n";

async function prepare(fileName: string) {
  const binFilePath = join(process.cwd(), "dist/bin", fileName);
  const file = Bun.file(binFilePath);
  const content = await file.text();

  // `bun build` reruns over the same output during a watch/rebuild, so adding
  // the shebang unconditionally would stack them up.
  if (!content.startsWith("#!")) {
    await Bun.write(binFilePath, SHEBANG + content);
  }

  await chmod(binFilePath, 0o755);
}

async function main() {
  for (const fileName of BIN_FILES) {
    await prepare(fileName);
  }
}

main();
