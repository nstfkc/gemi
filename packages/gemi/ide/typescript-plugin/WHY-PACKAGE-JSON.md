# Why there is a `package.json` here

tsserver does not resolve a plugin through the package's `exports` map. It does
plain Node directory resolution against the name in `tsconfig.json`, probing, in
order:

```
<pkg>/ide/typescript-plugin/package.json     ← this file
<pkg>/package.json
<pkg>/ide/typescript-plugin.js
<pkg>/ide/typescript-plugin/index.js
```

The built plugin lives at `<pkg>/dist/ide/typescript-plugin/index.js`, like every
other build output in this package, which is on none of those paths. This
`package.json` is the one probe location that can point at it, so it exists only
to say `main`.

Two consequences worth knowing:

- **In this repo the plugin needs a build.** `main` names a file under `dist/`,
  so `bun run build:ts-plugin` has to have run before an editor can load it from
  `templates/saas-starter`. The published tarball always has it.
- **`scripts/build-publish.ts` stages this file explicitly.** That script
  assembles the tarball from `dist/` plus a short list, rather than from the
  `files` field, so a new file outside `dist/` is invisible to it until it is
  named there. It is, and a check at the end of that script fails the publish if
  `main` does not resolve.

The `"./ide/typescript-plugin"` entry in the package's `exports` map is not what
makes any of this work — it is there so `scripts/build-publish.ts` verifies the
built file exists, and so the subpath is a declared part of the package surface
rather than an accident of layout.
