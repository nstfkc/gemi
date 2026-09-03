import { $ } from "bun";
import { x } from "tar";
import fetch from "node-fetch";
import { program } from "commander";
import prompts from "prompts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

async function fetchGemiVersion() {
  const url =
    "https://raw.githubusercontent.com/nstfkc/gemi/refs/heads/main/packages/gemi/package.json";
  const packageJson = await fetch(url).then((response) => response.json());
  return (packageJson as any).version;
}

async function fetchCreateGemiAppVersion() {
  const url =
    "https://raw.githubusercontent.com/nstfkc/gemi/refs/heads/main/packages/create-gemi-app/package.json";
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

const TEMPLATES = [
  { title: "SaaS Starter", value: "saas-starter" },
  { title: "Agentic SaaS (agent API example)", value: "agentic-saas" },
] as const;

program.option("-p, --project-name <projectName>", "Project name");
program.option("-t, --template <template>", "Template");

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

  // `-t` skips the prompt, so CI and the docs can name a template directly. An
  // unknown one is rejected here rather than at the download: the tar filter
  // silently matches nothing for a path that does not exist, and the failure
  // would otherwise surface as an empty project directory.
  if (template && !TEMPLATES.some((t) => t.value === template)) {
    console.error(
      `Unknown template "${template}". Available: ${TEMPLATES.map((t) => t.value).join(", ")}`,
    );
    process.exit(1);
  }

  if (!template) {
    const { value: _template } = await prompts({
      type: "select",
      name: "value",
      message: "Select a template",
      choices: TEMPLATES.map((t) => ({ title: t.title, value: t.value })),
    });

    // Ctrl-C at the select leaves this undefined, and an undefined template
    // downloads nothing at all.
    if (!_template) {
      process.exit(1);
    }

    template = _template;
  }

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
  await $`echo 2. run \`mv .env.example .env\` to create a .env file`;
  await $`echo 3. run \`bunx prisma migrate deploy\` to initialize the database and prisma client`;
  await $`echo 4. run \`bun dev\` to start the development server`;
});

program.parse();
