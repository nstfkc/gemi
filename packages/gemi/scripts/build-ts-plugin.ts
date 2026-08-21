/**
 * Builds the TypeScript language service plugin.
 *
 * It cannot ride along in `scripts/build.ts`, which emits ESM for Bun. tsserver
 * loads a plugin with `require()`, in Node, so this one has to be CommonJS with
 * a Node target — and standalone, because `splitting: true` would hand it a
 * shared chunk that `require()` cannot follow.
 *
 * `typescript` stays external on purpose. A plugin must use the copy tsserver
 * injects, never one of its own: two copies means two sets of enum values and
 * two `SyntaxKind` numberings, and the mismatch shows up as a plugin that
 * silently matches nothing.
 */
const result = await Bun.build({
  entrypoints: ["./ide/typescript-plugin/index.ts"],
  outdir: "./dist/ide/typescript-plugin",
  target: "node",
  format: "cjs",
  external: ["typescript"],
  sourcemap: "external",
  minify: false,
});

if (!result.success) {
  console.error("TypeScript plugin build failed");
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

// tsserver's `require` has to find `module.exports` as the initializer
// function. A bundler that emits `exports.default = …` instead produces a
// plugin the editor loads and then ignores, with nothing in the log to say so.
const output = await Bun.file("./dist/ide/typescript-plugin/index.js").text();
if (!/module\.exports\s*=/.test(output)) {
  console.error(
    "Refusing the built plugin: dist/ide/typescript-plugin/index.js does not assign " +
      "module.exports, so tsserver would require() it and get an object it cannot call.",
  );
  process.exit(1);
}

console.log("Built dist/ide/typescript-plugin/index.js");
