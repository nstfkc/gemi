import { $ } from "bun";
import { x } from "tar";
import fetch from "node-fetch";
import { program } from "commander";
import prompts from "prompts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const GEMI_VERSION = "0.4.10";

async function downloadTar(root: string) {
  const url = "https://codeload.github.com/nstfkc/gemi/tar.gz/main";
  const response = await fetch(url);
  const filePath = "templates/default";
  response.body?.pipe(
    x({
      strip: filePath.split("/").length + 1,
      cwd: root,
      filter: (path) => {
        return path.startsWith(`gemi-main/templates/default/`);
      },
    }),
  );
  return new Promise((resolve) => {
    response.body?.on("end", () => {
      resolve({});
    });
  });
}

program.option("-p, --project-name <projectName>", "Project name");

program.action(async (options) => {
  let projectName = options.projectName;

  if (!projectName) {
    const response = await prompts({
      type: "text",
      name: "projectName",
      message: "Enter project name:",
      initial: "my-app",
    });
    projectName = response.projectName;
  }
  if (!projectName) {
    process.exit(1);
  }

  console.log(`Extracting to ${process.cwd()}/${projectName}`);
  console.log("Downloading template...");

  await mkdir(projectName);

  const root = resolve(process.cwd(), projectName);

  await downloadTar(root);

  const file = Bun.file(`${root}/package.json`);
  const packageJSON = await file.json();

  let updatedPackageJSON = structuredClone(packageJSON);
  updatedPackageJSON.name = projectName;
  updatedPackageJSON.author = `Your name <your@email.com>`;
  updatedPackageJSON.dependencies.gemi = `${GEMI_VERSION}`;

  await Bun.write(
    `${root}/package.json`,
    JSON.stringify(updatedPackageJSON, null, 2),
  );

  console.log("Installing dependencies...");
  await $`bun i --cwd ${root}`;

  await $`git init ${root} -b main`;
  await $`echo Happy coding`;
  await $`echo visit "https://github.com/nstfkc/gemi for documentation"`;

  console.log("");
  console.log("");
  console.log("");

  await $`echo run cd \`${projectName}\` and run \`bun dev\` to start the development server`;
});

program.parse();
