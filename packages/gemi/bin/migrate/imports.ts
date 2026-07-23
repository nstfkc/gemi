import { matchDelims, skipAtomic } from "./lex";

export interface ImportSpecifier {
  imported: string;
  local: string;
  isType: boolean;
}

export interface ImportDecl {
  /** Byte range of the whole statement in the source it came from. */
  start: number;
  end: number;
  raw: string;
  module: string;
  /** `import type { … }` — the modifier applies to every specifier. */
  typeOnly: boolean;
  defaultName?: string;
  namespaceName?: string;
  named: ImportSpecifier[];
  /** `import "./side-effect";` */
  sideEffect: boolean;
}

const IMPORT_RE = /(^|\n)\s*import\b/g;

/**
 * Collects the top-level import statements of a module. Scans rather than
 * regex-matches the whole statement so that a `from` inside a string literal
 * cannot terminate it early.
 */
export function parseImports(src: string): ImportDecl[] {
  const decls: ImportDecl[] = [];
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = IMPORT_RE.exec(src))) {
    // `\s*` in the pattern may have eaten a blank line, so anchor on the
    // keyword itself rather than on where the match happened to start.
    const start = src.indexOf("import", match.index);
    // `import(` is a dynamic import expression, not a declaration.
    const afterKeyword = start + "import".length;
    if (/^\s*[(.]/.test(src.slice(afterKeyword))) continue;

    const end = findStatementEnd(src, afterKeyword);
    const raw = src.slice(start, end);
    const decl = parseOne(raw, start, end);
    if (decl) decls.push(decl);
    IMPORT_RE.lastIndex = end;
  }

  return decls;
}

function findStatementEnd(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      // A string here is either the module specifier or a `from "…"`. If the
      // statement ends right after it (optionally with a `;`), we are done.
      const rest = src.slice(skipped);
      const trailing = /^\s*;/.exec(rest);
      if (trailing) return skipped + trailing[0].length;
      const nl = /^[^\S\n]*(\n|$)/.exec(rest);
      if (nl) return skipped;
      i = skipped;
      continue;
    }
    i++;
  }
  return src.length;
}

function parseOne(
  raw: string,
  start: number,
  end: number,
): ImportDecl | undefined {
  const moduleMatch = /(['"])([^'"]*)\1\s*;?\s*$/.exec(raw);
  if (!moduleMatch) return undefined;
  const module = moduleMatch[2]!;

  const clause = raw
    .slice("import".length, moduleMatch.index)
    .replace(/\bfrom\s*$/, "")
    .trim();

  if (clause === "") {
    return {
      start,
      end,
      raw,
      module,
      typeOnly: false,
      named: [],
      sideEffect: true,
    };
  }

  let body = clause;
  let typeOnly = false;
  if (/^type\s/.test(body)) {
    typeOnly = true;
    body = body.slice("type".length).trim();
  }

  const decl: ImportDecl = {
    start,
    end,
    raw,
    module,
    typeOnly,
    named: [],
    sideEffect: false,
  };

  const braceStart = body.indexOf("{");
  const head = (braceStart === -1 ? body : body.slice(0, braceStart)).trim();
  for (const part of head.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const ns = /^\*\s*as\s+([\w$]+)$/.exec(token);
    if (ns) decl.namespaceName = ns[1];
    else if (/^[\w$]+$/.test(token)) decl.defaultName = token;
  }

  if (braceStart !== -1) {
    const braceEnd = body.lastIndexOf("}");
    const inner = body.slice(braceStart + 1, braceEnd);
    for (const part of inner.split(",")) {
      const token = part.trim();
      if (!token) continue;
      let isType = typeOnly;
      let rest = token;
      if (/^type\s+/.test(rest)) {
        isType = true;
        rest = rest.slice("type".length).trim();
      }
      const aliased = /^([\w$]+|"[^"]*")\s+as\s+([\w$]+)$/.exec(rest);
      if (aliased) {
        decl.named.push({ imported: aliased[1]!, local: aliased[2]!, isType });
      } else {
        decl.named.push({ imported: rest, local: rest, isType });
      }
    }
  }

  return decl;
}

/** Every local binding a declaration introduces. */
export function localNames(decl: ImportDecl): string[] {
  const names: string[] = [];
  if (decl.defaultName) names.push(decl.defaultName);
  if (decl.namespaceName) names.push(decl.namespaceName);
  for (const spec of decl.named) names.push(spec.local);
  return names;
}

export function printImport(decl: ImportDecl): string {
  if (decl.sideEffect) return `import "${decl.module}";`;

  const head: string[] = [];
  if (decl.defaultName) head.push(decl.defaultName);
  if (decl.namespaceName) head.push(`* as ${decl.namespaceName}`);

  const named = decl.named.map((spec) => {
    const prefix = !decl.typeOnly && spec.isType ? "type " : "";
    return spec.imported === spec.local
      ? `${prefix}${spec.local}`
      : `${prefix}${spec.imported} as ${spec.local}`;
  });

  const clause = [...head, named.length ? `{ ${named.join(", ")} }` : ""]
    .filter(Boolean)
    .join(", ");

  const typePrefix = decl.typeOnly ? "type " : "";
  const statement = `import ${typePrefix}${clause} from "${decl.module}";`;

  // Wrap long specifier lists the way the rest of the codebase (prettier
  // defaults, 80 columns) would.
  if (statement.length <= 80 || !named.length) return statement;
  const wrapped = named.map((n) => `  ${n},`).join("\n");
  const prefix = head.length ? `${head.join(", ")}, ` : "";
  return `import ${typePrefix}${prefix}{\n${wrapped}\n} from "${decl.module}";`;
}

/** True when `name` is referenced anywhere in `code` outside strings/comments. */
export function isUsed(code: string, name: string): boolean {
  const re = new RegExp(`(^|[^\\w$.])${escapeRe(name)}([^\\w$]|$)`);
  return re.test(stripLiterals(code));
}

function escapeRe(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Blanks out strings and comments so identifier scans cannot false-positive.
 * Template literals keep their `${…}` expressions — an import used only inside
 * one is still an import in use.
 */
export function stripLiterals(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "`") {
      const end = matchTemplate(src, i);
      out += ` ${stripLiterals(templateExpressions(src, i, end))} `;
      i = end;
      continue;
    }
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      out += " ".repeat(skipped - i);
      i = skipped;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function matchTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "`") return j + 1;
    if (src[j] === "$" && src[j + 1] === "{") {
      j = matchDelims(src, j + 1, "{", "}");
      continue;
    }
    j++;
  }
  return src.length;
}

/** Concatenates the `${…}` chunks of the template literal at `[start, end)`. */
function templateExpressions(src: string, start: number, end: number): string {
  const parts: string[] = [];
  let j = start + 1;
  while (j < end) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "$" && src[j + 1] === "{") {
      const close = matchDelims(src, j + 1, "{", "}");
      parts.push(src.slice(j + 2, close - 1));
      j = close;
      continue;
    }
    j++;
  }
  return parts.join(" ; ");
}
