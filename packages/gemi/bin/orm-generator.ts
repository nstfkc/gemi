import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { generatorHandler } from "@prisma/generator-helper";
import type { GeneratorOptions } from "@prisma/generator-helper";

import { emitArtifacts } from "./orm/emit";

// A Prisma generator plugin, deliberately *not* a `gemi` subcommand: Prisma owns
// schema and migrations, and gemi must not shadow or wrap the Prisma CLI. Apps
// add a second generator block and every `prisma generate` — including the one
// `prisma migrate dev` runs for them — refreshes the gemi artifacts with it:
//
//   generator gemi {
//     provider = "gemi-orm-generator"
//     output   = "../app/models/generated"
//   }
//
// The Prisma CLI spawns this file as its own process and talks JSON-RPC over
// stdio, which is why it needs its own `bin` entry, a shebang and an executable
// bit (see scripts/prepare-bin.ts).

// The generated `models.ts` type-imports `@prisma/client`, so the client
// generator has to have run. Prisma runs generator blocks in declaration order,
// so `generator client` coming first is usually enough — but relying on that
// silently means an app that reorders its blocks gets code that does not
// typecheck and no explanation of why.
const CLIENT_PROVIDERS = new Set(["prisma-client-js", "prisma-client"]);

function assertPrismaClientGenerator(options: GeneratorOptions): void {
  const hasClient = options.otherGenerators.some((generator) =>
    CLIENT_PROVIDERS.has(generator.provider.value ?? ""),
  );
  if (hasClient) return;

  throw new Error(
    "The gemi ORM generator needs the Prisma client generator, because the " +
      "model bases it emits type-import `@prisma/client`. Add a " +
      '`generator client { provider = "prisma-client-js" }` block to your ' +
      "schema, above the gemi block — Prisma runs generators in declaration " +
      "order.",
  );
}

// `@prisma/generator-helper` is a devDependency bundled into this binary, so the
// DMMF reader's version is frozen at gemi's publish time. An app on a much newer
// Prisma would otherwise get a silently mismatched reader — the DMMF is
// Prisma-internal and has changed shape across majors. Warn rather than throw:
// the mismatch is usually harmless, and refusing to generate would be a worse
// failure than a noisy one.
const SUPPORTED_PRISMA_MAJOR = 6;

function warnOnPrismaVersion(options: GeneratorOptions): void {
  const major = Number.parseInt(options.version?.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major === SUPPORTED_PRISMA_MAJOR) return;

  console.warn(
    `gemi ORM: this is Prisma ${options.version}, but the gemi ORM generator ` +
      `was built against Prisma ${SUPPORTED_PRISMA_MAJOR}.x. The artifacts are ` +
      `still generated; check them, and upgrade gemi if they look wrong.`,
  );
}

// Informational only. Which dialect the ORM speaks is a *runtime* property read
// from `DatabaseManager`, because `DATABASE_URL` can point at a different
// database than the one generation saw. Nothing dialect-specific is ever baked
// into a generated file, so this cannot do more than warn.
const SUPPORTED_PROVIDERS = new Set([
  "sqlite",
  "postgresql",
  "postgres",
  "prisma+postgres",
]);

function warnOnDatasource(options: GeneratorOptions): void {
  const datasource = options.datasources[0];
  if (!datasource || SUPPORTED_PROVIDERS.has(datasource.provider)) return;

  console.warn(
    `gemi ORM: this schema's datasource is '${datasource.provider}', which the ` +
      `gemi ORM cannot execute queries against yet. The artifacts are still ` +
      `generated — they are dialect-agnostic — but queries will fail at runtime.`,
  );
}

generatorHandler({
  onManifest: () => ({
    prettyName: "gemi ORM",
    defaultOutput: "../app/models/generated",
  }),

  onGenerate: async (options: GeneratorOptions) => {
    const output = options.generator.output?.value;
    if (!output) {
      throw new Error(
        "The gemi ORM generator needs an `output` path. Add " +
          '`output = "../app/models/generated"` to the generator block.',
      );
    }

    assertPrismaClientGenerator(options);
    warnOnPrismaVersion(options);
    warnOnDatasource(options);

    // Prisma hands the DMMF over directly, so nothing here parses
    // `schema.prisma`.
    const files = emitArtifacts(options.dmmf.datamodel.models);

    await mkdir(output, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(output, name), content, "utf8");
    }
  },
});
