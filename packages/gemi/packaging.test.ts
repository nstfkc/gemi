import { $ } from "bun";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * The published package, installed into an application, typechecked.
 *
 * Everything else that guards packaging in this repository is a *proxy* for
 * this. `exports-map.test.ts` reads source paths and says in its own comment
 * that it cannot see `dist/`. `scripts/build-publish.ts` checks that files
 * exist in the staging directory. Both can pass while an installed app is
 * broken, because neither ever installs anything.
 *
 * They did, up to 0.55.0. `gemi.d.ts` is what carries an app's route types — it
 * augments `RPC` / `ViewRPC` with `CreateRPC<Api>` so `useQuery("/health")`
 * resolves — and the scaffold pointed at it twice, from `tsconfig.json`'s
 * `types` and from a root `gemi.d.ts`. It was in neither tarball: `files` is
 * `dist/**` and `build-publish.ts` stages `dist/` plus a short list that did not
 * include it. So every published version shipped two pointers at a file that
 * was not there, and `tsc` in a scaffolded app stopped at
 *
 *     error TS2688: Cannot find type definition file for './node_modules/gemi/gemi.d.ts'
 *
 * before reporting anything else. It survived because nothing here installed
 * the package and compiled against it, and because the template has no
 * `typecheck` script — `test:types` runs with `--typecheck.ignoreSourceErrors`,
 * which swallows exactly this.
 *
 * So this test does the one thing the proxies cannot: build, pack, extract into
 * a fixture app shaped like a scaffolded project, and run the real compiler. It
 * covers the augmentation shipping, the reference surviving declaration emit
 * (`tsc` drops `/// <reference path>`, so a build step re-adds it — see
 * `scripts/wire-augmentation.ts`), the `exports` conditions resolving and the
 * path alias working, as one behaviour observed from outside the package.
 *
 * The fixture deliberately has **no** gemi wiring of its own. That is the claim
 * now being made: an application declares routes and imports `gemi/client`, and
 * the types follow.
 *
 * **It runs `bun run build:publish`, which recreates `dist/`.** That side effect
 * is why it is held out of the default `vitest run` and given its own CI step,
 * last — see `vitest.config.ts`. Held out rather than skipped behind a flag: a
 * packaging test that only runs when someone remembers is not running. About
 * eight seconds, five of them the build.
 */

/** Mirrors what a scaffolded app declares, small enough to read in one screen. */
const FIXTURE = {
  "app/http/routes/api.ts": `import { ApiRouter } from "gemi/http";

export default class extends ApiRouter {
  routes = {
    "/health": this.get(() => ({ ok: true })),
  };
}
`,
  "app/http/routes/view.ts": `import { ViewRouter } from "gemi/http";

export default class extends ViewRouter {
  routes = {
    "/": this.view("Home"),
  };
}
`,
  "app/i18n/index.ts": `export default {};
`,
  // Two files rather than two functions, so a diagnostic can be attributed by
  // filename. TypeScript's error for a bad route *lists the valid ones* — so
  // "no diagnostic mentions /health" is satisfied by a broken build and
  // violated by a working one. Asking which file complained is not.
  //
  // Plain modules rather than components: React and the JSX runtime are not
  // what is under test, and leaving them out keeps the fixture small.
  "app/views/declared.ts": `import { useQuery } from "gemi/client";

export function declared() {
  return useQuery("/health");
}
`,
  "app/views/undeclared.ts": `import { useQuery } from "gemi/client";

export function undeclared() {
  return useQuery("/definitely-not-a-route");
}
`,
  // Compiled separately, and it has to be: the augmentation is global once
  // anything pulls it in, so a server file sitting in the same program as the
  // two above would be typed by `gemi/client`'s reference no matter what
  // `gemi/facades` did. Only a program that imports the facades and nothing
  // else can tell whether the second entrypoint is wired.
  "server/declared.ts": `import { Query } from "gemi/facades";

export function declared() {
  return Query.prefetch("/health");
}
`,
  "server/undeclared.ts": `import { Query } from "gemi/facades";

export function undeclared() {
  return Query.prefetch("/definitely-not-a-route");
}
`,
  "package.json": `{ "name": "packaging-fixture", "private": true }\n`,
};

const PACKAGE_ROOT = import.meta.dirname;
const REPO_ROOT = join(PACKAGE_ROOT, "../..");
const TSC = join(PACKAGE_ROOT, "node_modules/typescript/bin/tsc");

let fixture: string;
let diagnostics: string;
let serverDiagnostics: string;
let exitCode: number;

beforeAll(async () => {
  expect(existsSync(TSC), `no compiler at ${TSC}`).toBe(true);

  // The publisher's own command, so the tarball is the one that would ship.
  await $`bun run build:publish`.cwd(PACKAGE_ROOT).quiet();

  const staging = join(PACKAGE_ROOT, ".publish");
  const version = (await Bun.file(join(staging, "package.json")).json()).version;
  await $`npm pack --silent`.cwd(staging).quiet();
  const tarball = join(staging, `gemi-${version}.tgz`);
  expect(existsSync(tarball), `npm pack produced no ${tarball}`).toBe(true);

  fixture = await mkdtemp(join(tmpdir(), "gemi-packaging-"));
  await mkdir(join(fixture, "node_modules"), { recursive: true });

  // `npm pack` output extracts to `package/`, which is what an install lays
  // down as `node_modules/gemi`.
  await $`tar -xzf ${tarball} -C ${join(fixture, "node_modules")}`.quiet();
  await $`mv ${join(fixture, "node_modules/package")} ${join(fixture, "node_modules/gemi")}`.quiet();

  // The app's own toolchain, borrowed rather than installed. Only `typescript`
  // is needed to compile; the other two are here because gemi's own `.d.ts`
  // files reference them, and while `skipLibCheck` hides that, borrowing them
  // keeps the fixture honest about what an app has.
  for (const dependency of ["typescript", "react", "@types"]) {
    const target = join(PACKAGE_ROOT, "node_modules", dependency);
    expect(existsSync(target), `cannot link missing ${target}`).toBe(true);
    await symlink(target, join(fixture, "node_modules", dependency));
  }

  for (const [path, contents] of Object.entries(FIXTURE)) {
    const absolute = join(fixture, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }

  // Taken from the template rather than written here, so the test tracks
  // whatever wiring the scaffold actually ships — including, now, none. The
  // scaffold used to carry a root `gemi.d.ts` pointing at
  // `./node_modules/gemi/gemi.d.ts`; the package references its own
  // augmentation instead, so there is nothing left to copy. Conditional rather
  // than deleted, so this keeps mirroring the template if that changes again.
  const template = join(REPO_ROOT, "templates/saas-starter");
  const scaffoldTypes = join(template, "gemi.d.ts");
  if (existsSync(scaffoldTypes)) await cp(scaffoldTypes, join(fixture, "gemi.d.ts"));

  // Whole-line `//` comments only, which is all the template's tsconfig uses.
  // A trailing comment would reach `JSON.parse` and fail here with something
  // opaque, so fail on purpose instead, naming the cause.
  const rawConfig = await Bun.file(join(template, "tsconfig.json")).text();
  const stripped = rawConfig.replace(/^\s*\/\/.*$/gm, "");
  if (/\S\s*\/\//.test(stripped)) {
    throw new Error(
      "the template's tsconfig.json has a trailing // comment, which this " +
        "stripper does not handle — widen it rather than reformatting the template",
    );
  }
  const config = JSON.parse(stripped);
  // `vite/client` and `bun` are the app's toolchain, not gemi's delivery, and
  // the fixture does not install them. Whatever gemi-related entry survives is
  // the wiring under test — currently none, which is the whole point.
  //
  // `plugins` is dropped defensively: the template does not set one today, and
  // `tsc` ignores language service plugins anyway, but an added one must not
  // change what this measures.
  delete config.compilerOptions.plugins;
  config.compilerOptions.types = (config.compilerOptions.types ?? []).filter((entry: string) =>
    entry.includes("gemi"),
  );
  await writeFile(
    join(fixture, "tsconfig.json"),
    JSON.stringify({ ...config, include: ["app"] }, null, 2),
  );
  await writeFile(
    join(fixture, "tsconfig.server.json"),
    JSON.stringify({ ...config, include: ["server"] }, null, 2),
  );

  const client = await $`${TSC} --noEmit -p tsconfig.json`.cwd(fixture).nothrow().quiet();
  diagnostics = client.text();
  exitCode = client.exitCode;

  const server = await $`${TSC} --noEmit -p tsconfig.server.json`.cwd(fixture).nothrow().quiet();
  serverDiagnostics = server.text();
}, 600_000);

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe("the published package, installed into an app", () => {
  test("resolves every type entry point the scaffold points at", () => {
    // TS2688 is a configuration error, and `tsc` abandons the run on one — so
    // this failing makes every assertion below meaningless rather than merely
    // wrong. It is first for that reason.
    //
    // Vacuous while the scaffold names no gemi `types` entry, which is the
    // point of the change this guards: it re-arms the moment one comes back.
    const missing = diagnostics
      .split("\n")
      .filter((line) => line.includes("TS2688"))
      .join("\n");

    expect(missing, `the tarball is missing something the app's tsconfig names:\n${missing}`).toBe(
      "",
    );
  });

  test("types a route the app declared", () => {
    const complaints = diagnostics
      .split("\n")
      .filter((line) => line.startsWith("app/views/declared.ts"))
      .join("\n");

    expect(complaints, `useQuery("/health") should typecheck:\n${diagnostics}`).toBe("");
  });

  test("wires gemi/facades too, not just gemi/client", () => {
    // Compiled on its own — see `server/probe.ts`. Drop `dist/facades/index.d.ts`
    // from `wire-augmentation.ts` and every other assertion here still passes
    // while server-only code loses `Query.prefetch`, `Redirect.to` and
    // `Url.absolute`.
    const declared = serverDiagnostics
      .split("\n")
      .filter((line) => line.startsWith("server/declared.ts"))
      .join("\n");
    const undeclared = serverDiagnostics
      .split("\n")
      .filter((line) => line.startsWith("server/undeclared.ts"))
      .join("\n");

    expect(declared, `Query.prefetch("/health") should typecheck:\n${serverDiagnostics}`).toBe("");
    expect(
      undeclared,
      `Query.prefetch("/definitely-not-a-route") should be an error:\n${serverDiagnostics || "(nothing)"}`,
    ).not.toBe("");
  });

  test("rejects a route the app never declared", () => {
    // Also the liveness check for the two above. An empty program, a compiler
    // that never ran, or a `useQuery` degraded to `any` all produce a clean
    // run — and a clean run has to fail here, or "no errors" would pass as
    // "correct" for the rest of this file.
    const complaints = diagnostics
      .split("\n")
      .filter((line) => line.startsWith("app/views/undeclared.ts"))
      .join("\n");

    expect(
      complaints,
      `useQuery("/definitely-not-a-route") should be an error, but tsc exited ${exitCode} saying:\n${diagnostics || "(nothing)"}`,
    ).not.toBe("");
  });
});
