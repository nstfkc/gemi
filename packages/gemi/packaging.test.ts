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

/**
 * A browser app built with Vite against the installed package, for what
 * lands in the entry chunk every route loads (#891, #915). `main.tsx` is the
 * entry and uses neither realtime hook; lazily loaded views follow a channel,
 * a `ChangeFeed`, write into the query cache and read error helpers, and
 * download files. Outside `app/` so `tsc` above never sees it.
 */
const CLIENT_FIXTURE = {
  "web/main.tsx": `import { init, Link, useQuery } from "gemi/client";

function RootLayout({ children }: { children?: unknown }) {
  const { data } = useQuery("/health");
  return <body><Link href="/">home</Link>{String(data)}{children as never}</body>;
}

(window as any).views = {
  Plain: () => import("./Plain"),
  Live: () => import("./Live"),
  Feed: () => import("./Feed"),
  Writes: () => import("./Writes"),
  Files: () => import("./Files"),
  Voice: () => import("./Voice"),
};
init(RootLayout);
`,
  "web/Plain.tsx": `import { usePost, useQuery } from "gemi/client";

export default function Plain() {
  const { data } = useQuery("/health");
  const save = usePost("/health" as never);
  return <button onClick={() => save.trigger({} as never)}>{String(data)}</button>;
}
`,
  "web/Live.tsx": `import { useChannel, useQuery } from "gemi/client";

export default function Live() {
  const { status } = useChannel("site" as never, {}, { onResync() {} });
  const { data } = useQuery("/health", {}, { live: "site" as never });
  return <p>{status}{String(data)}</p>;
}
`,
  "web/Feed.tsx": `import { useSubscription } from "gemi/client";

export default function Feed() {
  const { status } = useSubscription("/health" as never, {}, { onChange: console.log });
  return <p>{status}</p>;
}
`,
  "web/Writes.tsx": `import { usePost, useSetQueryData } from "gemi/client";

export default function Writes() {
  const setQueryData = useSetQueryData();
  const save = usePost("/health" as never, {} as never, {
    updates: [{ path: "/health" as never }],
    onSuccess: (data: unknown) => setQueryData({ path: "/health" as never }, data as never),
  } as never);
  const error = save.error as any;
  return <p>{error?.list().join()}{error?.field("name").join()}</p>;
}
`,
  // A second app, with queries and nothing else: every lazily loaded gemi
  // chunk goes unused, which is where an emitted-but-unused one shows (see
  // "needs no chunk besides the entry to start").
  "web-query/main.tsx": `import { init, useQuery } from "gemi/client";

function RootLayout({ children }: { children?: unknown }) {
  const { data } = useQuery("/health");
  return <body>{String(data)}{children as never}</body>;
}

(window as any).views = { Query: () => import("./Query") };
init(RootLayout);
`,
  "web-query/Query.tsx": `import { useQuery } from "gemi/client";

export default function Query() {
  return <p>{String(useQuery("/health").data)}</p>;
}
`,
  // Uses `gemi/client` as well, like every real view: a lazy chunk that
  // imports React and nothing the entry holds makes the bundler move React
  // out of the entry into a shared chunk, whatever gemi does.
  "web/Voice.tsx": `import { useQuery } from "gemi/client";
import { useVoiceSession } from "gemi/ai/voice";

export default function Voice() {
  const { data } = useQuery("/health");
  const voice = useVoiceSession("/chat/voice" as never, { threadId: String(data) });
  return <button onClick={() => voice.start()}>{voice.status}</button>;
}
`,
  "web/Files.tsx": `import { fetchBlob, fetchText } from "gemi/client";

export default function Files() {
  return <button onClick={() => Promise.all([fetchBlob("/f" as never), fetchText("/t" as never)])}>get</button>;
}
`,
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
  for (const dependency of ["typescript", "react", "react-dom", "@types"]) {
    const target = join(PACKAGE_ROOT, "node_modules", dependency);
    expect(existsSync(target), `cannot link missing ${target}`).toBe(true);
    await symlink(target, join(fixture, "node_modules", dependency));
  }

  for (const [path, contents] of Object.entries({ ...FIXTURE, ...CLIENT_FIXTURE })) {
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

  // `configFile: false`: the fixture's own build, not this package's.
  const { build } = await import("vite");
  for (const app of ["web", "web-query"]) {
    await build({
      root: join(fixture, app),
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: join(fixture, `${app}-dist`),
        manifest: true,
        rollupOptions: { input: join(fixture, app, "main.tsx") },
      },
    });
  }
}, 600_000);

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe("what the tarball must not carry", () => {
  /**
   * Both of these are one edit away from coming back, and neither shows up as a
   * failing test anywhere else — the leak is silent in this package and lands in
   * the consumer.
   *
   * `tsconfig.build.json` is what keeps them out, and it is fragile by
   * construction: its `exclude` replaces the parent's rather than extending it,
   * and moving the same exclusion up into `tsconfig.json` (which is where it
   * started) disables the type-test suite instead — 102 tests reported green
   * while checking nothing. So the property is asserted on the packed artefact,
   * where neither mistake can hide.
   */
  test("no type-test declarations, and no augmentation of a consumer's RPC", async () => {
    const installed = join(fixture, "node_modules/gemi");

    const testDeclarations = (await $`find ${installed} -name "*.test-d.d.ts"`.quiet()).text();
    expect(
      testDeclarations.trim(),
      "a *.test-d.d.ts reached the tarball: check tsconfig.build.json still excludes them, " +
        "and that build:types uses it",
    ).toBe("");

    // `declare module "../client/rpc"` in a shipped declaration adds routes to
    // the interface an app's own routes augment. The type tests each write one to
    // give themselves a route to assert against, and so does `ai/example.ts`.
    const augmenting = (
      await $`grep -rl ${'declare module "../client/rpc"'} ${installed}`.nothrow().quiet()
    ).text();
    expect(
      augmenting.trim(),
      `a shipped declaration augments the consumer's RPC:\n${augmenting}`,
    ).toBe("");
  });
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

describe("the published client, built into an app", () => {
  /**
   * The realtime socket and `useSubscription`'s SSE connection (#891), and
   * the mutation hooks' extras and `fetchBlob`'s request (#915), are loaded on
   * first use, with a dynamic `import()`. A value import of
   * `client/realtime/RealtimeClient`, `client/subscriptionStream`,
   * `client/mutationErrorHelpers`, `client/queryUpdates` or
   * `client/fetchFileRequest` from anything the entry reaches puts it back in
   * every route's entry chunk, which no unit test would notice: an app's
   * bundler places a module by what statically reaches it, and its entry
   * reaches all of `gemi/client`.
   */
  const MARKERS = {
    socket: ["gemi.v1", "__gemi/socket", "hiddenDisconnectMs"],
    subscription: ["Last-Event-ID", "text/event-stream"],
    // The error helpers' validation check (`mutationErrorList` has it too,
    // which the fixture never calls) and the cache writes' walk over a
    // resource's variants (#915). Not `error.list()`'s fallback message: the
    // hooks keep it in the entry for when this chunk cannot be loaded.
    mutationExtras: ["validation_error", ".variantKeys()"],
    fileRequest: ["content-disposition"],
    // `useVoiceSession` (#921), from `gemi/ai/voice`: the hook and its peer
    // connection, used by a lazily loaded view only.
    voiceHook: ["ask_agent"],
    voiceCall: ["oai-events", "getUserMedia"],
  };
  const ALL_MARKERS = Object.values(MARKERS).flat();

  async function chunks() {
    const out = join(fixture, "web-dist");
    const manifest = await Bun.file(join(out, ".vite/manifest.json")).json();
    const entry = (Object.values(manifest) as Array<{ file: string; isEntry?: boolean }>).find(
      (chunk) => chunk.isEntry,
    );
    expect(entry, "the fixture build produced no entry chunk").toBeDefined();
    const files = (await $`find ${out} -name "*.js"`.quiet()).text().trim().split("\n");
    const code = new Map<string, string>();
    for (const file of files) code.set(file, await Bun.file(file).text());
    return { entry: code.get(join(out, entry!.file))!, code };
  }

  test("keeps the socket client, the SSE reader, the mutation extras and the file request out of the entry chunk", async () => {
    const { entry } = await chunks();
    for (const marker of ALL_MARKERS) {
      expect(entry.includes(marker), `the entry chunk contains "${marker}"`).toBe(false);
    }
  });

  test("still ships each of them, in chunks of their own", async () => {
    // The liveness check for the one above: markers that are in no chunk at
    // all would pass it while measuring nothing.
    const { entry, code } = await chunks();
    for (const marker of ALL_MARKERS) {
      const holders = [...code].filter(([, text]) => text !== entry && text.includes(marker));
      expect(holders.length, `no lazy chunk contains "${marker}"`).toBeGreaterThan(0);
    }
  });

  test.each(["web", "web-query"])("%s needs no chunk besides the entry to start", async (app) => {
    // A gemi chunk loaded lazily that imports from the code the entry holds,
    // and whose `import()` the app's bundler drops as unused, can still be
    // emitted. The bundler then moves that shared code out of the entry into a
    // chunk of its own, which every route imports statically and which in our
    // builds costs about 0.8 KB gzip more. It happened in an app with no
    // mutation hook, once `gemi/testing` imported `client/mutationModules`
    // (#915).
    const manifest: Record<string, { isEntry?: boolean; imports?: string[] }> = await Bun.file(
      join(fixture, `${app}-dist/.vite/manifest.json`),
    ).json();
    const entry = Object.values(manifest).find((chunk) => chunk.isEntry)!;
    expect(entry.imports ?? []).toEqual([]);
  });

  // Modules with no string of their own to look for go by the manifest: the
  // gemi chunk each is built into must be a dynamic entry of the app's build,
  // not something the entry imports statically.
  test.each([
    ["`useQuery`'s live subscription", "live"],
    ["the mutation hooks' extras (error helpers, cache writes)", "mutationExtras"],
  ])("loads %s lazily too", async (_, name) => {
    const manifest: Record<
      string,
      { file: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[] }
    > = await Bun.file(join(fixture, "web-dist/.vite/manifest.json")).json();
    const pattern = new RegExp(`node_modules/gemi/dist/chunks/${name}-[^/]+\\.js$`);
    const lazy = Object.entries(manifest).find(([key]) => pattern.test(key));
    expect(lazy, `no chunk built from gemi's ${name} module:\n${Object.keys(manifest).join("\n")}`).toBeDefined();
    expect(lazy![1].isDynamicEntry).toBe(true);
    const entry = Object.entries(manifest).find(([, chunk]) => chunk.isEntry)!;
    expect(lazy![1].file).not.toBe(entry[1].file);
    expect(entry[1].imports ?? []).not.toContain(lazy![0]);
  });
});
