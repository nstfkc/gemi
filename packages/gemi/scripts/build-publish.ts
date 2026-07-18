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

// `exports` entries whose published target isn't a mechanical `./x.ts` ->
// `./dist/x.js` rewrite. Keep this table as the single place that documents the
// exceptions.
//   - `./runtime` is a legacy export: its source (`client/runtime.ts`) and this
//     built target don't currently exist and nothing imports `gemi/runtime`, but
//     the mapping is preserved as-is to avoid changing the published surface.
const PUBLISH_EXPORT_OVERRIDES: Record<string, string> = {
  "./runtime": "./dist/runtime/index.js",
};

// Map the source `exports` to their built `dist/` equivalents:
//   - an explicit override wins;
//   - a value already under `./dist/` (e.g. `./vite`) is kept verbatim;
//   - anything else is `./<path>.ts` -> `./dist/<path>.js`.
// Non-string values (future conditional exports) pass through untouched.
function toPublishExports(
  devExports: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(devExports)) {
    if (key in PUBLISH_EXPORT_OVERRIDES) {
      out[key] = PUBLISH_EXPORT_OVERRIDES[key];
    } else if (typeof value !== "string") {
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
