import { $ } from "bun";
import { x } from "tar";
import fetch from "node-fetch";
import { program } from "commander";
import prompts from "prompts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

async function downloadTar(root: string) {
  const url = "https://codeload.github.com/nstfkc/gemi/tar.gz/main";
  const response = await fetch(url);
  response.body?.pipe(
    x({
      strip: 1,
      cwd: root,
    }),
  );
  return new Promise((resolve) => {
    response.body?.on("end", () => {
      resolve({});
    });
  });
}

console.log("Installing dependencies...");

// await downloadTar();

program.option("-p, --project-name <projectName>", "Project name");

program.action(async (options) => {
  let projectName = options.projectName;

  if (!projectName) {
    const response = await prompts({
      type: "text",
      name: "projectName",
      message: "Enter project name:",
    });
    projectName = response.projectName;
  }

  console.log(`Extracting to ${process.cwd()}/${projectName}`);
  console.log("Downloading template...");

  await mkdir(projectName);

  const root = resolve(process.cwd(), projectName);

  await downloadTar(root);

  const email = (await $`git config --global user.email`)
    .text()
    .replaceAll("\n", "");
  const name = (await $`git config --global user.name`)
    .text()
    .replaceAll("\n", "");

  const file = Bun.file(`${root}/package.json`);
  const packageJSON = await file.json();
  console.log(packageJSON);

  let updatedPackageJSON = structuredClone(packageJSON);
  updatedPackageJSON.name = projectName;
  updatedPackageJSON.author = `${name} <${email}>`;

  await Bun.write(
    `${root}/package.json`,
    JSON.stringify(updatedPackageJSON, null, 2),
  );

  console.log({ email, name });
  console.log("Installing dependencies...");
  return;
  await $`bun i --cwd ${root}`;

  await $`git init ${root} -b main`;
  await $`echo Happy coding`;
  await $`echo visit "https://github.com/nstfkc/gemi/README.md for documentation"`;
});

program.parse();
