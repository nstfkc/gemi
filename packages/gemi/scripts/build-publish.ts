import { $ } from "bun";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Assemble a ready-to-publish package in `.publish/` without ever mutating the
// committed `package.json`.
//
// The committed `exports` map points at TypeScript *source* so the linked
// package resolves with no build step during in-repo development (templates and
// apps import `gemi/*` and run it straight through Bun). The published package
// must instead point at the compiled output under `dist/`. Rather than swap the
// committed file at publish time (fragile: a failed publish leaves the working
// tree stuck on the built map), we derive the published map here and write it to
// a throwaway staging directory that npm publishes from.
const STAGING = ".publish";

// Map the source `exports` to their built `dist/` equivalents:
//   - a value already under `./dist/` (e.g. `./vite`) is kept verbatim;
//   - anything else is `./<path>.ts` -> `./dist/<path>.js`.
// Non-string values (future conditional exports) pass through untouched.
//
// There is deliberately no override table. The one entry it ever held existed
// to keep `./runtime` publishable after its source was deleted, by pointing at
// a built file the JS build does not emit either — so the override did not
// rescue the export, it hid the fact that it was already broken. The export is
// gone; if a genuine exception turns up, a table is easy to reintroduce, and it
// should carry a test rather than a comment.
function toPublishExports(
  devExports: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(devExports)) {
    if (typeof value !== "string") {
      out[key] = value;
    } else if (value.startsWith("./dist/")) {
      out[key] = value;
    } else {
      out[key] = value.replace(/^\.\//, "./dist/").replace(/\.tsx?$/, ".js");
    }
  }
  return out;
}

// Build the package (this recreates `dist/` from scratch).
await $`bun run build`;

const pkg = await Bun.file("package.json").json();

const publishPkg = { ...pkg };
publishPkg.exports = toPublishExports(pkg.exports);
// Neither is needed by consumers, and dropping `scripts` also drops the
// `prepublishOnly` guard so publishing from the staging dir isn't blocked.
delete publishPkg.scripts;
delete publishPkg.devDependencies;

await rm(STAGING, { recursive: true, force: true });
await mkdir(STAGING, { recursive: true });
await cp("dist", join(STAGING, "dist"), { recursive: true });
// The one shipped file that is not build output. tsserver resolves a language
// service plugin by Node directory rules and never reads `exports`, so
// `gemi/ide/typescript-plugin` only resolves if this `package.json` is in the
// tarball to point `main` at the built file. See the note beside it.
await mkdir(join(STAGING, "ide", "typescript-plugin"), { recursive: true });
await cp(
  join("ide", "typescript-plugin", "package.json"),
  join(STAGING, "ide", "typescript-plugin", "package.json"),
);
await Bun.write(
  join(STAGING, "package.json"),
  `${JSON.stringify(publishPkg, null, 2)}\n`,
);
// npm bundles README/LICENSE automatically when they sit next to package.json.
for (const extra of ["README.md", "LICENSE", "LICENSE.md"]) {
  if (await Bun.file(extra).exists()) await cp(extra, join(STAGING, extra));
}

// Every published subpath must name a file that is actually in the staged
// tarball. This is the check that catches the bug class `./runtime` belonged to
// — an `exports` entry whose *published* target was never built — and it has to
// live here rather than in a test, because only this script has a built `dist/`
// to look at.
//
// A unit test over `package.json` cannot do this job. The published targets are
// `./dist/…` paths that do not exist until `bun run build` runs, and three
// separate builds produce them: `scripts/build.ts` for most entrypoints, then
// `vite.client.config.mts` for `./client` and `vite.plugin.config.mts` for
// `./vite`'s `.mjs`. Neither vite input is listed in the first, so dropping an
// entry from either config would dangle an export with nothing to notice —
// exactly this bug, recurring.
//
// Failing beats warning: the failure mode is a package that installs cleanly
// and fails on import, which is the worst time to find out.
const dangling: string[] = [];
for (const [subpath, target] of Object.entries(publishPkg.exports)) {
  if (typeof target !== "string") continue;
  if (!(await Bun.file(join(STAGING, target)).exists())) {
    dangling.push(`  ${subpath} -> ${target}`);
  }
}

if (dangling.length > 0) {
  console.error(
    `Refusing to stage gemi@${pkg.version}: ${dangling.length} of ` +
      `${Object.keys(publishPkg.exports).length} published exports name a file ` +
      `that was not built.\n${dangling.join("\n")}\n\n` +
      `Either the entry is stale and should be deleted from \`exports\`, or the ` +
      `build that produces it (scripts/build.ts, vite.client.config.mts, ` +
      `vite.plugin.config.mts) no longer emits it.`,
  );
  process.exit(1);
}

// Existing is not the same as loadable. `sideEffects` (see the note at the top
// of `build.ts`) produces a `dist/services/index.js` that is present, correctly
// named, the right size to look plausible, and throws `Exported binding … needs
// to refer to a top-level declared variable` on import — every check above
// passes it. So the two barrels an application actually imports are imported.
//
// Only those two: they are the entrypoints with no runtime prerequisites of
// their own. `./client` and `./vite` want a DOM and a Vite config, and a smoke
// test that needs a fixture to run is one that gets deleted the first time it
// is inconvenient.
const BARRELS = ["./services", "./facades"];

for (const subpath of BARRELS) {
  const target = publishPkg.exports[subpath];
  if (typeof target !== "string") continue;

  const proc = Bun.spawnSync([
    process.execPath,
    "-e",
    `await import(${JSON.stringify(join(process.cwd(), STAGING, target))})`,
  ]);

  if (proc.exitCode !== 0) {
    console.error(
      `Refusing to stage gemi@${pkg.version}: \`import "gemi${subpath.slice(1)}"\` ` +
        `throws against the staged build.\n\n${proc.stderr.toString().trim()}\n\n` +
        `The file is there and the export map points at it — the bundle itself ` +
        `is broken. Check anything that changes what \`scripts/build.ts\` is ` +
        `allowed to eliminate.`,
    );
    process.exit(1);
  }
}

// The plugin is the one entry whose loader ignores `exports`, so the check
// above cannot speak for it: tsserver reaches it through
// `ide/typescript-plugin/package.json`'s `main`. A tarball where that path
// dangles installs fine and produces an editor that quietly has no route jumps,
// with the reason buried in the tsserver log.
const pluginShim = join(STAGING, "ide", "typescript-plugin", "package.json");
const pluginMain = join(
  STAGING,
  "ide",
  "typescript-plugin",
  (await Bun.file(pluginShim).json()).main,
);
if (!(await Bun.file(pluginMain).exists())) {
  console.error(
    `Refusing to stage gemi@${pkg.version}: the TypeScript plugin's package.json ` +
      `points main at ${pluginMain}, which was not built. Run \`bun run build:ts-plugin\`.`,
  );
  process.exit(1);
}

console.log(
  `Staged gemi@${pkg.version} in ${STAGING}/ — ` +
    `${Object.keys(publishPkg.exports).length} exports, all resolved, ` +
    `${BARRELS.length} barrels imported clean. ` +
    `Publish with: (cd ${STAGING} && npm publish)`,
);
