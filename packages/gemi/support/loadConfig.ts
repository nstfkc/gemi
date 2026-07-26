import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";

import { Repository } from "./Repository";

const CONFIG_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".jsx"];

// Builds a Repository from an already-imported map of config modules. The map
// key becomes the top-level config key, so `{ mail: mailModule }` is readable
// as `config.get("mail.driver")`. Each entry may be either the module namespace
// (its `default` export is unwrapped) or the config object itself.
export function createConfigRepository(
  modules: Record<string, any> = {},
): Repository {
  const items: Record<string, any> = {};

  for (const [key, mod] of Object.entries(modules)) {
    items[key] = unwrap(mod);
  }

  return new Repository(items);
}

// Reads every config module in an app's `app/config` directory into a
// Repository. The file's basename is the top-level key: `app/config/mail.ts`
// populates `mail.*`. A missing directory yields an empty Repository so apps
// that declare no config still boot.
export async function loadConfigFrom(
  directory: string,
  repository = new Repository(),
): Promise<Repository> {
  let entries: string[] = [];

  try {
    entries = await readdir(directory);
  } catch (err) {
    return repository;
  }

  const files = entries
    .filter((entry) => {
      const { ext, name } = parse(entry);
      return CONFIG_EXTENSIONS.includes(ext) && !name.startsWith(".");
    })
    .sort();

  for (const file of files) {
    const { name } = parse(file);
    const mod = await import(join(directory, file));
    repository.set(name, unwrap(mod));
  }

  return repository;
}

function unwrap(mod: any) {
  if (mod && typeof mod === "object" && "default" in mod) {
    return mod.default;
  }
  return mod;
}
