# AI Prompt Files

Keep an agent's prompts as Markdown files with `{{placeholders}}`, and fill them with `Prompt.render` from `gemi/ai`.

```typescript
import { Prompt } from "gemi/ai";

// app/agents/siteNamer/name.md:
//   Name a website for {{business}}. Answer with {{count}} options.
//   {{> tone}}
const instructions = Prompt.render("siteNamer/name", { business: "a bakery", count: 3 });
```

## Where prompts live

Names resolve under `app/agents` (relative to the working directory, which is the app's root when gemi runs it):

| Name | File |
|---|---|
| `siteNamer/name` | `app/agents/siteNamer/name.md` |
| `prompts/styles/editorial` | `app/agents/prompts/styles/editorial.md` |
| `copy-guide` (no `/`) | `app/agents/prompts/copy-guide.md` |

A name with a `/` is a path, so a prompt can sit beside its agent. A bare name is a shared prompt in `prompts/`. Names use letters, digits, `-` and `_`, with `/` between folders; anything else (`..`, an absolute path) throws.

In dev, tests and evals the files are read from disk, so an edit applies at once and everything reads the same files.

## Deploying without `app/` source

`gemi build` copies every Markdown file under `app/agents` into `dist/server/prompts.json`. Under `gemi start` (`NODE_ENV=production`), `Prompt.render` and `Prompt.placeholders` read that file first, so an image that ships only `dist/` renders its prompts the same as one that ships `app/agents`. Placeholder checks and partials work as they do on disk.

- A prompt the manifest lacks (a file added after the build, or a `dir` outside `app/agents`) is read from disk, as before.
- Outside production the manifest is ignored, so a stale `dist/` never shadows an edited prompt.
- The manifest holds the prompts' text: treat `dist/server` as you treat `app/agents`.

## Placeholders

- `{{name}}` is replaced with `String(values.name)`. Values are strings or numbers.
- A placeholder with no value throws: `The prompt "siteNamer/name" has no value for {{count}}.` A prompt never reaches the model with a placeholder left in it.
- A value no placeholder uses is ignored.
- Only `{{word}}` with no spaces is a placeholder, so `style={{ color: x }}` or `{{ example }}` in a prompt is left as written.
- Values are inserted as they are and not scanned again, so a value containing `{{x}}` stays literal.
- The file's final newline is dropped.

## Partials

`{{> name}}` includes another prompt, resolved by the same rules, before placeholders are filled. The partial shares the caller's values.

```markdown
<!-- app/agents/prompts/credit-prices.md -->
A page costs {{pagePrice}} credits.

<!-- app/agents/builder/system.md -->
You build pages for {{business}}.

{{> credit-prices}}
```

```typescript
Prompt.render("builder/system", { business: "a bakery", pagePrice: 5 });
```

Partials nest. A missing partial throws, and so does a partial that includes itself (`a > b > a`).

## Listing placeholders

`Prompt.placeholders(name)` answers the placeholder names a prompt uses, partials included, each once. Useful in a test that checks a caller passes every value:

```typescript
expect(Object.keys(values).sort()).toEqual(Prompt.placeholders("siteNamer/name").sort());
```

## Caching and configuration

In production (`NODE_ENV=production`) each file is read once and kept (the build's manifest is read once too). Otherwise it is read on every render, so an edited prompt applies at once in dev.

`Prompt.configure` changes the defaults. Call it once at boot (a service provider, `app/preload.ts`, a test setup file); each call replaces the previous options and clears the cache.

The manifest covers `app/agents` only. A `dir` elsewhere is still read from disk in production, so ship that folder in the image.

```typescript
Prompt.configure({
  dir: "app/agents",   // where names resolve (relative to the working directory, or absolute)
  shared: "prompts",   // the folder under `dir` for bare names
  cache: true,         // default: NODE_ENV === "production"
});
```
