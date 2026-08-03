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
await Bun.write(
  join(STAGING, "package.json"),
  `${JSON.stringify(publishPkg, null, 2)}\n`,
);
// npm bundles README/LICENSE automatically when they sit next to package.json.
for (const extra of ["README.md", "LICENSE", "LICENSE.md"]) {
  if (await Bun.file(extra).exists()) await cp(extra, join(STAGING, extra));
}

console.log(
  `Staged gemi@${pkg.version} in ${STAGING}/ — publish with: (cd ${STAGING} && npm publish)`,
);
