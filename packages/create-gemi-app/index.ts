import { $ } from "bun";
import { x } from "tar";
import fetch from "node-fetch";
import { program } from "commander";
import prompts from "prompts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

async function fetchGemiVersion() {
  const url =
    "https://raw.githubusercontent.com/nstfkc/gemi/main/packages/gemi/package.json";
  const packageJson = await fetch(url).then((response) => response.json());
  return (packageJson as any).version;
}

async function fetchCreateGemiAppVersion() {
  const url =
    "https://raw.githubusercontent.com/nstfkc/gemi/main/packages/create-gemi-app/package.json";
  const packageJson = await fetch(url).then((response) => response.json());
  return (packageJson as any).version;
}

async function downloadTar(root: string, template = "default") {
  const url = "https://codeload.github.com/nstfkc/gemi/tar.gz/main";
  const response = await fetch(url);
  const filePath = `templates/${template}`;
  response.body?.pipe(
    x({
      strip: filePath.split("/").length + 1,
      cwd: root,
      filter: (path) => {
        return path.startsWith(`gemi-main/templates/${template}/`);
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
program.option("-t, --template <template>", "Template", "blank");

program.action(async (options) => {
  let projectName = options.projectName;
  let template = options.template;

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

  const { value: _template } = await prompts({
    type: "select",
    name: "value",
    message: "Select a template",
    choices: [
      { title: "Blank", value: "blank" },
      { title: "SaaS Starter", value: "saas-starter" },
    ],
  });

  template = _template;

  console.log(`Extracting to ${process.cwd()}/${projectName}`);
  console.log("Downloading template...");

  const [GEMI_VERSION, CREATE_GEMI_APP_VERSION] = await Promise.all([
    fetchGemiVersion(),
    fetchCreateGemiAppVersion(),
  ]);

  console.log(`Using gemi version ${GEMI_VERSION}`);
  console.log(`Using create gemi app version ${CREATE_GEMI_APP_VERSION}`);

  await mkdir(projectName);

  const root = resolve(process.cwd(), projectName);

  await downloadTar(root, template);

  const file = Bun.file(`${root}/package.json`);
  const packageJSON = await file.json();

  let updatedPackageJSON = structuredClone(packageJSON);
  updatedPackageJSON.name = projectName;
  updatedPackageJSON.author = `Your name <your@email.com>`;
  updatedPackageJSON.dependencies.gemi = GEMI_VERSION;

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

  await $`echo 1. run cd \`${projectName}\``;
  await $`echo 2. run \`bunx prisma migrate deploy\` to initialize the database and prisma client`;
  await $`echo 3. run \`mv .env.example .env\` to create a .env file`;
  await $`echo 4. run \`bun dev\` to start the development server`;
});

program.parse();
