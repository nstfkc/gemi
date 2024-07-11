import { join } from "path";
import { chmod } from "fs/promises";

async function main() {
  const binFilePath = join(process.cwd(), "/bin/index.js");
  const file = Bun.file(binFilePath);
  const content = await file.text();

  const shebang = "#!/usr/bin/env bun\n";

  await Bun.write(binFilePath, shebang + content);

  // add chmod +x to the file
  await chmod(binFilePath, 0o755);
}

main();
