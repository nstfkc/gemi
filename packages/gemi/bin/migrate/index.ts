import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { findClasses, parseMembers } from "./classBody";
import type { ClassDecl, ClassMember } from "./classBody";
import { isUsed, parseImports, printImport, stripLiterals } from "./imports";
import type { ImportDecl } from "./imports";
import { renameIdentifier } from "./lex";
import {
  DELETED_EXPORTS,
  EXTRACTION_TARGETS,
  FACADE_RENAMES,
  MODULE_MOVES,
  PROVIDER_MIGRATIONS,
  SECTION_ORDER,
  SERVICE_RENAMES,
  TODO,
} from "./tables";
import type { ProviderMigration } from "./tables";

export interface MigrateOptions {
  rootDir: string;
  dryRun?: boolean;
}

interface Note {
  file: string;
  message: string;
}

interface Change {
  file: string;
  contents: string | null; // null = delete
}

const GEMI_MODULES = [
  "gemi/services",
  "gemi/kernel",
  "gemi/http",
  "gemi/i18n",
  "gemi/facades",
  "gemi/broadcasting",
];

export async function runMigrate(options: MigrateOptions) {
  const { rootDir, dryRun = false } = options;
  const appDir = path.join(rootDir, "app");

  if (!existsSync(appDir)) {
    console.error(`No app/ directory found in ${rootDir}. Nothing to migrate.`);
    process.exitCode = 1;
    return;
  }

  const notes: Note[] = [];
  const changes: Change[] = [];

  const providersDir = path.join(appDir, "kernel", "providers");
  const slices = new Map<string, SliceInput[]>();
  const migratedFiles: string[] = [];
  // Providers the codemod does not recognise stay on disk; the Kernel keeps
  // referencing them, just through the new `providers` array.
  const carriedProviders: string[] = [];

  if (existsSync(providersDir)) {
    for (const entry of readdirSync(providersDir).sort()) {
      if (!/\.tsx?$/.test(entry)) continue;
      const file = path.join(providersDir, entry);
      const parsed = readProvider(file, rootDir, notes);
      if (!parsed) {
        carriedProviders.push(entry.replace(/\.tsx?$/, ""));
        continue;
      }
      migratedFiles.push(file);
      const list = slices.get(parsed.migration.configKey) ?? [];
      list.push(parsed);
      slices.set(parsed.migration.configKey, list);
    }
  } else {
    notes.push({
      file: rel(rootDir, providersDir),
      message:
        "no app/kernel/providers directory — skipped the provider-to-config step",
    });
  }

  const aliasPrefix = detectAliasPrefix(appDir);

  // 1. Provider classes -> app/config/*.ts, plus any behaviour classes they
  //    happened to declare inline.
  for (const [configKey, inputs] of slices) {
    const emitted = buildConfigFile(
      configKey,
      inputs,
      { rootDir, appDir, aliasPrefix },
      notes,
    );
    changes.push({
      file: path.join(appDir, "config", `${configKey}.ts`),
      contents: emitted.contents,
    });
    for (const extracted of emitted.extractedFiles) {
      if (existsSync(extracted.file)) {
        notes.push({
          file: rel(rootDir, extracted.file),
          message: "already exists — left untouched, review it by hand",
        });
        continue;
      }
      changes.push({ file: extracted.file, contents: extracted.contents });
    }
  }

  // 2. Kernel.
  const kernelFile = path.join(appDir, "kernel", "Kernel.ts");
  if (existsSync(kernelFile)) {
    changes.push({
      file: kernelFile,
      contents: buildKernel(
        kernelFile,
        [...slices.keys()],
        carriedProviders,
        rootDir,
        notes,
      ),
    });
  } else {
    notes.push({
      file: "app/kernel/Kernel.ts",
      message: "not found — the Kernel rewrite was skipped",
    });
  }

  // 3. The app's own provider, which is where anything that used to live in a
  //    provider's `boot()` now belongs.
  const appProviderFile = path.join(appDir, "providers", "AppServiceProvider.ts");
  if (!existsSync(appProviderFile)) {
    changes.push({ file: appProviderFile, contents: APP_SERVICE_PROVIDER });
  }

  // 4. Provider files whose contents now live in app/config are superseded.
  for (const file of migratedFiles) changes.push({ file, contents: null });

  // 5. Renames across the rest of the app.
  const touched = new Set(changes.map((change) => change.file));
  for (const file of walk(appDir)) {
    if (touched.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const rewritten = rewriteReferences(source, rel(rootDir, file), notes);
    if (rewritten !== source) changes.push({ file, contents: rewritten });
  }

  // Apply.
  for (const change of changes) {
    const label = rel(rootDir, change.file);
    if (change.contents === null) {
      console.log(`  delete  ${label}`);
      if (!dryRun) rmSync(change.file, { force: true });
      continue;
    }
    const verb = existsSync(change.file) ? "update" : "create";
    console.log(`  ${verb.padStart(6)}  ${label}`);
    if (dryRun) continue;
    mkdirSync(path.dirname(change.file), { recursive: true });
    writeFileSync(change.file, change.contents);
  }

  if (!dryRun && existsSync(providersDir) && readdirSync(providersDir).length === 0) {
    rmSync(providersDir, { recursive: true, force: true });
  }

  report(notes, dryRun);
}

// ---------------------------------------------------------------------------
// Providers -> config
// ---------------------------------------------------------------------------

interface SliceInput {
  file: string;
  source: string;
  imports: ImportDecl[];
  classes: ClassDecl[];
  providerClass: ClassDecl;
  members: ClassMember[];
  migration: ProviderMigration;
}

function readProvider(
  file: string,
  rootDir: string,
  notes: Note[],
): SliceInput | undefined {
  const label = rel(rootDir, file);
  // Facade/service renames apply inside a provider body too — `FileStorage` in
  // an `onLogFileClosed` hook has to become `Storage` on the way to config.
  // `keepProviders` stops this pass from flagging the very base class the
  // provider extends, which the config rewrite is about to delete anyway.
  const source = rewriteReferences(readFileSync(file, "utf8"), label, notes, {
    keepProviders: true,
  });
  const imports = parseImports(source);
  const classes = findClasses(source);
  const providerClass = classes.find((cls) => cls.isDefaultExport);

  if (!providerClass) {
    notes.push({
      file: label,
      message:
        "no `export default class` found — left in place, migrate it by hand",
    });
    return undefined;
  }

  const superName = providerClass.superClass;
  const imported = superName
    ? resolveImportedName(imports, superName)
    : undefined;
  const migration = PROVIDER_MIGRATIONS.find(
    (entry) => entry.provider === (imported ?? superName),
  );

  if (!migration) {
    notes.push({
      file: label,
      message: `extends \`${superName ?? "?"}\`, which is not a known 0.42 service provider — left in place, migrate it by hand`,
    });
    return undefined;
  }

  const members = parseMembers(
    source,
    providerClass.bodyStart,
    providerClass.bodyEnd,
  );

  return { file, source, imports, classes, providerClass, members, migration };
}

/** Maps a local binding back to the name it was imported under. */
function resolveImportedName(imports: ImportDecl[], local: string) {
  for (const decl of imports) {
    if (decl.defaultName === local) return local;
    for (const spec of decl.named) if (spec.local === local) return spec.imported;
  }
  return undefined;
}

interface BuildContext {
  rootDir: string;
  appDir: string;
  aliasPrefix: string | null;
}

function buildConfigFile(
  configKey: string,
  inputs: SliceInput[],
  ctx: BuildContext,
  notes: Note[],
) {
  inputs.sort(
    (a, b) =>
      SECTION_ORDER.indexOf(a.migration.section ?? "") -
      SECTION_ORDER.indexOf(b.migration.section ?? ""),
  );

  const defineFn = inputs[0]!.migration.defineFn;
  const defineModule = inputs[0]!.migration.defineModule;

  const extractedFiles: { file: string; contents: string }[] = [];
  const carriedImports: ImportDecl[] = [];
  const preambles: string[] = [];
  const sections: string[] = [];

  for (const input of inputs) {
    const label = rel(ctx.rootDir, input.file);

    // Inner behaviour classes move out to their own modules.
    const inner = input.classes.filter(
      (cls) => cls !== input.providerClass && cls.name,
    );

    for (const cls of inner) {
      const target = cls.superClass
        ? EXTRACTION_TARGETS[cls.superClass]
        : undefined;
      const text = input.source.slice(cls.start, cls.end);
      if (!target) {
        notes.push({
          file: label,
          message: `class \`${cls.name}\` extends \`${cls.superClass ?? "nothing"}\`; it was copied into app/config/${configKey}.ts as-is — move it somewhere better if you care`,
        });
        preambles.push(text);
        continue;
      }

      const file = path.join(ctx.rootDir, target, `${cls.name}.ts`);
      const body = text.startsWith("export") ? text : `export ${text}`;
      const needed = input.imports
        .filter((decl) => !decl.sideEffect)
        .map((decl) => narrowImport(decl, text))
        .filter((decl): decl is ImportDecl => decl !== undefined);
      extractedFiles.push({
        file,
        contents: `${needed.map(printImport).join("\n")}\n\n${body}\n`,
      });
      carriedImports.push(
        syntheticImport(cls.name!, moduleSpecifier(ctx, target, cls.name!)),
      );
    }

    const indentWidth = input.migration.section ? 4 : 2;
    const rendered = renderMembers(
      input.members,
      input.migration,
      label,
      indentWidth,
      notes,
    );

    if (input.migration.section) {
      sections.push(
        rendered.trim()
          ? `  ${input.migration.section}: {\n${rendered}\n  },`
          : `  ${input.migration.section}: {},`,
      );
    } else {
      sections.push(rendered);
    }
  }

  const body = sections.filter((section) => section.trim()).join("\n");
  const objectLiteral = body ? `{\n${body}\n}` : "{}";
  const exportStatement = `export default ${defineFn}(${objectLiteral});\n`;

  // Header: everything the provider files had that was not the provider class
  // or an extracted class, with imports rewritten to what is still referenced.
  const headerImports: ImportDecl[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    for (const decl of input.imports) {
      const key = printImport(decl);
      if (seen.has(key)) continue;
      seen.add(key);
      headerImports.push(decl);
    }
  }

  const consumerCode = [...preambles, exportStatement].join("\n");

  const finalImports: string[] = [];
  let definePlaced = false;
  for (const decl of headerImports) {
    let next: ImportDecl | undefined = narrowImport(decl, consumerCode);
    // Drop the now-deleted provider base class and slot the `define*` helper
    // into the same import statement when the module still lines up.
    const droppedProvider = decl.named.some((spec) =>
      PROVIDER_MIGRATIONS.some((entry) => entry.provider === spec.imported),
    );
    if (droppedProvider && decl.module === defineModule && !definePlaced) {
      const index = decl.named.findIndex((spec) =>
        PROVIDER_MIGRATIONS.some((entry) => entry.provider === spec.imported),
      );
      const named = (next ?? { ...decl, named: [] }).named.filter(
        (spec) => !PROVIDER_MIGRATIONS.some((e) => e.provider === spec.imported),
      );
      named.splice(Math.max(0, index), 0, {
        imported: defineFn,
        local: defineFn,
        isType: false,
      });
      next = { ...decl, named, typeOnly: false };
      definePlaced = true;
    }
    if (!next) continue;
    if (!definePlaced && next.module === defineModule && !next.typeOnly) {
      next = {
        ...next,
        named: [
          { imported: defineFn, local: defineFn, isType: false },
          ...next.named,
        ],
      };
      definePlaced = true;
    }
    finalImports.push(printImport(rewriteImportNames(next)));
  }

  if (!definePlaced) {
    finalImports.unshift(
      `import { ${defineFn} } from "${defineModule}";`,
    );
  }

  for (const decl of carriedImports) finalImports.push(printImport(decl));

  const parts = [finalImports.join("\n")];
  if (preambles.length) parts.push(preambles.join("\n\n"));
  parts.push(exportStatement);

  return { contents: parts.join("\n\n").replace(/\n{3,}/g, "\n\n"), extractedFiles };
}

function renderMembers(
  members: ClassMember[],
  migration: ProviderMigration,
  label: string,
  width: number,
  notes: Note[],
): string {
  const sourceIndent = 2;
  const shift = width - sourceIndent;
  const lines: string[] = [];

  for (const member of members) {
    if (member.blankBefore) lines.push("");
    if (member.leading.trim()) lines.push(reindent(member.leading, width, shift));

    if (member.kind === "unsupported") {
      notes.push({
        file: label,
        message: `\`${member.name ?? member.text.split(/\s/)[0]}\` — ${member.reason}; left commented out in the config file`,
      });
      lines.push(
        reindent(
          `${TODO} ${member.reason}. The 0.42 source is kept below.`,
          width,
          shift,
        ),
      );
      lines.push(
        member.text
          .split("\n")
          .map((line, index) => {
            const body =
              index === 0
                ? line
                : line.startsWith(" ".repeat(sourceIndent))
                  ? line.slice(sourceIndent)
                  : line.trimStart();
            return `${" ".repeat(width)}// ${body}`.trimEnd();
          })
          .join("\n"),
      );
      continue;
    }

    const rename = migration.memberRenames?.[member.name!];
    if (rename) {
      notes.push({
        file: label,
        message: `\`${member.name}\` was renamed to \`${rename}\``,
      });
    }
    const name = rename ?? member.name!;

    if (member.kind === "property") {
      lines.push(reindent(`${name}: ${member.value},`, width, shift));
      continue;
    }

    const prefix = member.modifiers.includes("async") ? "async " : "";
    let signature = member.signature!;
    if (rename) signature = signature.replace(member.name!, rename);
    lines.push(reindent(`${prefix}${signature},`, width, shift));
  }

  return lines.join("\n");
}

function reindent(text: string, width: number, shift: number): string {
  return text
    .split("\n")
    .map((line, index) => {
      if (index === 0) return " ".repeat(width) + line;
      if (!line.trim()) return "";
      return shift >= 0
        ? " ".repeat(shift) + line
        : line.slice(Math.min(-shift, line.length - line.trimStart().length));
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Kernel
// ---------------------------------------------------------------------------

function buildKernel(
  file: string,
  configKeys: string[],
  carriedProviders: string[],
  rootDir: string,
  notes: Note[],
): string {
  const source = readFileSync(file, "utf8");
  const imports = parseImports(source);
  const kernelClass = findClasses(source).find((cls) => cls.isDefaultExport);

  // local name -> the provider module it came from, for the `./providers/*`
  // imports the old Kernel used.
  const providerLocals = new Map<string, string>();
  for (const decl of imports) {
    if (/(^|\/)providers\//.test(decl.module) && decl.defaultName) {
      providerLocals.set(decl.defaultName, decl.module);
    }
  }

  const carried = [...providerLocals]
    .filter(([, module]) =>
      carriedProviders.includes(module.split("/").pop() ?? ""),
    )
    .map(([local, module]) => ({ local, module }));

  const leftovers: ClassMember[] = [];
  if (kernelClass) {
    for (const member of parseMembers(
      source,
      kernelClass.bodyStart,
      kernelClass.bodyEnd,
    )) {
      const isProviderSlot =
        member.kind === "property" &&
        member.value &&
        providerLocals.has(member.value.trim());
      if (isProviderSlot) continue;
      leftovers.push(member);
    }
  }

  const keys = [...configKeys].sort();
  const lines: string[] = [`import { Kernel } from "gemi/kernel";`, ""];
  for (const key of keys) lines.push(`import ${key} from "../config/${key}";`);
  if (keys.length) lines.push("");
  for (const provider of carried) {
    lines.push(`import ${provider.local} from "${provider.module}";`);
  }
  lines.push(`import AppServiceProvider from "../providers/AppServiceProvider";`);
  lines.push("");
  lines.push("export default class extends Kernel {");
  if (keys.length) {
    lines.push("  config = {");
    for (const key of keys) lines.push(`    ${key},`);
    lines.push("  };");
    lines.push("");
  }
  if (carried.length) {
    for (const provider of carried) {
      notes.push({
        file: rel(rootDir, file),
        message: `\`${provider.local}\` was not recognised, so it stays a provider — it is now listed in \`providers\`. Make it extend \`ServiceProvider\` from \`gemi/support\`.`,
      });
    }
    lines.push(
      `  ${TODO} these providers were carried over as-is. They must extend`,
    );
    lines.push("  // `ServiceProvider` from `gemi/support` to keep working.");
    lines.push(
      `  providers = [${[...carried.map((p) => p.local), "AppServiceProvider"].join(", ")}];`,
    );
  } else {
    lines.push("  providers = [AppServiceProvider];");
  }

  for (const member of leftovers) {
    notes.push({
      file: rel(rootDir, file),
      message: `Kernel member \`${member.name ?? "?"}\` is not part of the 0.43 Kernel shape; it was carried over commented out`,
    });
    lines.push("");
    lines.push(
      `  ${TODO} this member has no 0.43 equivalent on Kernel. Move it to a`,
    );
    lines.push("  // ServiceProvider or an app/config/*.ts slice.");
    lines.push(
      member.text
        .split("\n")
        .map((line) => `  // ${line.trim()}`)
        .join("\n"),
    );
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

const APP_SERVICE_PROVIDER = `import { ServiceProvider } from "gemi/support";

/**
 * The application's own service provider. It is registered after the
 * framework's, so anything bound here wins over a framework binding of the
 * same token.
 */
export default class AppServiceProvider extends ServiceProvider {
  /**
   * Bind things into the container. Nothing may be resolved here — the other
   * providers have not necessarily registered yet.
   *
   *   this.app.singleton(Billing, () => new Billing(this.app.config.get("billing", {})));
   *   this.app.bind(Clock, () => new SystemClock());
   */
  register() {}

  /**
   * Runs after every provider has registered, so resolving is safe here. This
   * is where authorization gates and policies, view/route macros and any other
   * cross-cutting wiring belong.
   */
  async boot() {}
}
`;

// ---------------------------------------------------------------------------
// Reference renames across the rest of app/
// ---------------------------------------------------------------------------

function rewriteReferences(
  source: string,
  label: string,
  notes: Note[],
  options: { keepProviders?: boolean } = {},
): string {
  const imports = parseImports(source);
  const edits: { start: number; end: number; text: string }[] = [];
  const identifierRenames: [string, string][] = [];
  let result = source;

  for (const decl of imports) {
    if (!GEMI_MODULES.includes(decl.module)) continue;

    const kept: typeof decl.named = [];
    const moved = new Map<string, typeof decl.named>();
    const todoLines: string[] = [];

    for (const spec of decl.named) {
      const deleted = DELETED_EXPORTS[spec.imported];
      if (deleted) {
        todoLines.push(`${TODO} ${deleted}`);
        notes.push({ file: label, message: deleted });
        kept.push(spec);
        continue;
      }

      const provider = PROVIDER_MIGRATIONS.find(
        (entry) => entry.provider === spec.imported,
      );
      if (provider && options.keepProviders) {
        kept.push(spec);
        continue;
      }
      if (provider) {
        const message = `\`${spec.imported}\` was removed. Its settings now live in \`app/config/${provider.configKey}.ts\` (\`${provider.defineFn}\`).`;
        todoLines.push(`${TODO} ${message}`);
        notes.push({ file: label, message });
        kept.push(spec);
        continue;
      }

      const move = MODULE_MOVES[spec.imported];
      if (move && move.from.includes(decl.module)) {
        const list = moved.get(move.to) ?? [];
        list.push(spec);
        moved.set(move.to, list);
        notes.push({
          file: label,
          message: `\`${spec.imported}\` moved from \`${decl.module}\` to \`${move.to}\``,
        });
        continue;
      }

      const table =
        decl.module === "gemi/facades" ? FACADE_RENAMES : SERVICE_RENAMES;
      const renamed = table[spec.imported];
      if (renamed) {
        const aliased = spec.local !== spec.imported;
        kept.push({
          imported: renamed,
          local: aliased ? spec.local : renamed,
          isType: spec.isType,
        });
        if (!aliased) identifierRenames.push([spec.imported, renamed]);
        notes.push({
          file: label,
          message: `\`${spec.imported}\` -> \`${renamed}\``,
        });
        continue;
      }

      kept.push(spec);
    }

    const pieces: string[] = [];
    for (const line of todoLines) pieces.push(line);
    if (kept.length || decl.defaultName || decl.namespaceName) {
      pieces.push(printImport({ ...decl, named: kept }));
    }
    for (const [module, specs] of moved) {
      pieces.push(
        printImport({
          ...decl,
          module,
          defaultName: undefined,
          namespaceName: undefined,
          named: specs,
        }),
      );
    }

    const replacement = pieces.join("\n");
    if (replacement !== decl.raw) {
      edits.push({ start: decl.start, end: decl.end, text: replacement });
    }
  }

  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }

  for (const [from, to] of identifierRenames) {
    result = renameIdentifier(result, from, to);
  }

  // `.use()` is gone — the container resolves services now.
  for (const name of Object.values(SERVICE_RENAMES)) {
    if (!new RegExp(`\\b${name}\\.use\\s*\\(`).test(stripLiterals(result))) {
      continue;
    }
    const message = `\`${name}.use()\` no longer exists. Resolve it with \`app(${name})\` from \`gemi/foundation\`.`;
    notes.push({ file: label, message });
    result = result.replace(
      new RegExp(`([ \\t]*)(?=[^\\n]*\\b${name}\\.use\\s*\\()`),
      `$1${TODO} ${message}\n$1`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keeps only the specifiers `code` actually references. */
function narrowImport(decl: ImportDecl, code: string): ImportDecl | undefined {
  if (decl.sideEffect) return decl;
  const named = decl.named.filter((spec) => isUsed(code, spec.local));
  const defaultName =
    decl.defaultName && isUsed(code, decl.defaultName)
      ? decl.defaultName
      : undefined;
  const namespaceName =
    decl.namespaceName && isUsed(code, decl.namespaceName)
      ? decl.namespaceName
      : undefined;
  if (!named.length && !defaultName && !namespaceName) return undefined;
  return { ...decl, named, defaultName, namespaceName };
}

/** Applies the facade/service rename tables to an import's specifiers. */
function rewriteImportNames(decl: ImportDecl): ImportDecl {
  const table =
    decl.module === "gemi/facades" ? FACADE_RENAMES : SERVICE_RENAMES;
  return {
    ...decl,
    named: decl.named.map((spec) => {
      const renamed = table[spec.imported];
      if (!renamed) return spec;
      return {
        imported: renamed,
        local: spec.local === spec.imported ? renamed : spec.local,
        isType: spec.isType,
      };
    }),
  };
}

function syntheticImport(name: string, module: string): ImportDecl {
  return {
    start: -1,
    end: -1,
    raw: "",
    module,
    typeOnly: false,
    named: [{ imported: name, local: name, isType: false }],
    sideEffect: false,
  };
}

function moduleSpecifier(ctx: BuildContext, dir: string, name: string) {
  if (ctx.aliasPrefix) return `${ctx.aliasPrefix}${dir}/${name}`;
  const from = path.join(ctx.appDir, "config");
  const to = path.join(ctx.rootDir, dir, name);
  const relative = path.relative(from, to).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** `@/` when the app already imports through it, otherwise relative paths. */
function detectAliasPrefix(appDir: string): string | null {
  for (const file of walk(appDir)) {
    const source = readFileSync(file, "utf8");
    if (/from\s+["']@\/app\//.test(source)) return "@/";
  }
  return null;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith("."))
      continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

function rel(rootDir: string, file: string) {
  return path.relative(rootDir, file).split(path.sep).join("/");
}

function report(notes: Note[], dryRun: boolean) {
  console.log("");
  if (!notes.length) {
    console.log(
      dryRun
        ? "Dry run complete. Nothing needs manual attention."
        : "Migration complete. Nothing needs manual attention.",
    );
    return;
  }

  const grouped = new Map<string, string[]>();
  for (const note of notes) {
    const list = grouped.get(note.file) ?? [];
    if (!list.includes(note.message)) list.push(note.message);
    grouped.set(note.file, list);
  }

  console.log(dryRun ? "Would report:" : "Summary:");
  for (const [file, messages] of grouped) {
    console.log(`\n  ${file}`);
    for (const message of messages) console.log(`    - ${message}`);
  }
  console.log(
    `\nSearch the tree for \`TODO(gemi-migrate)\` to find everything that needs a decision.`,
  );
  console.log(`See UPGRADE.md for the 0.42 -> 0.43 notes.`);
}
