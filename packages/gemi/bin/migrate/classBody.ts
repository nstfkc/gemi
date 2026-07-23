import {
  isBalanced,
  matchDelims,
  skipAtomic,
  skipTrivia,
  skipWhitespace,
} from "./lex";

export interface ClassDecl {
  /** Byte range of the whole `class … { … }` declaration (incl. `export`). */
  start: number;
  end: number;
  name?: string;
  superClass?: string;
  isDefaultExport: boolean;
  bodyStart: number;
  bodyEnd: number;
}

export type MemberKind = "property" | "method" | "accessor" | "unsupported";

export interface ClassMember {
  kind: MemberKind;
  /** The author left a blank line above this member; keep it. */
  blankBefore: boolean;
  /** Comments and blank lines that precede the member, verbatim. */
  leading: string;
  /** The member source, from its first modifier through its terminator. */
  text: string;
  name?: string;
  modifiers: string[];
  /** Property right-hand side, with the type annotation and `;` removed. */
  value?: string;
  /** Method text from the name onward: `name(args) { … }`. */
  signature?: string;
  reason?: string;
}

const CLASS_RE =
  /(^|\n)([ \t]*)((?:export\s+default\s+|export\s+)?(?:abstract\s+)?class\b)/g;

export function findClasses(src: string): ClassDecl[] {
  const classes: ClassDecl[] = [];
  CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CLASS_RE.exec(src))) {
    const start = match.index + match[1]!.length + match[2]!.length;
    const isDefaultExport = match[3]!.includes("default");
    const classKeyword = src.indexOf("class", start);
    let i = classKeyword + "class".length;

    // `class Name<T> extends Base<T> implements I` — everything up to the `{`.
    const braceIndex = findClassBrace(src, i);
    const header = src.slice(i, braceIndex);
    const nameMatch = /^\s*([\w$]+)/.exec(header);
    const superMatch = /\bextends\s+([\w$.]+)/.exec(header);

    const bodyEnd = matchDelims(src, braceIndex, "{", "}");

    classes.push({
      start,
      end: bodyEnd,
      name: nameMatch?.[1],
      superClass: superMatch?.[1],
      isDefaultExport,
      bodyStart: braceIndex + 1,
      bodyEnd: bodyEnd - 1,
    });

    CLASS_RE.lastIndex = bodyEnd;
  }

  return classes;
}

function findClassBrace(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      i = skipped;
      continue;
    }
    const c = src[i];
    if (c === "<") {
      i = matchDelims(src, i, "<", ">");
      continue;
    }
    if (c === "(") {
      i = matchDelims(src, i, "(", ")");
      continue;
    }
    if (c === "{") return i;
    i++;
  }
  return src.length;
}

const MODIFIERS = [
  "static",
  "readonly",
  "declare",
  "abstract",
  "override",
  "public",
  "private",
  "protected",
  "async",
  "accessor",
];

/** Splits a class body into members, keeping each member's leading comments. */
export function parseMembers(
  src: string,
  bodyStart: number,
  bodyEnd: number,
): ClassMember[] {
  const members: ClassMember[] = [];
  let i = bodyStart;

  while (i < bodyEnd) {
    const afterWhitespace = skipWhitespace(src, i, bodyEnd);
    const memberStart = skipTrivia(src, afterWhitespace, bodyEnd);
    if (memberStart >= bodyEnd) break;

    const gap = src.slice(i, afterWhitespace);
    const blankBefore = members.length > 0 && (gap.match(/\n/g)?.length ?? 0) > 1;

    // Trailing blank lines belong to the gap, not to the member's comments.
    const rawLeading = src.slice(afterWhitespace, memberStart);
    const leading = rawLeading.replace(/^\s*\n/, "").replace(/\s+$/, "");

    const end = findMemberEnd(src, memberStart, bodyEnd);
    const text = src.slice(memberStart, end).trimEnd();
    members.push(classifyMember(text, leading, blankBefore));
    i = end;
  }

  return members;
}

function findMemberEnd(src: string, start: number, bodyEnd: number): number {
  let i = start;
  let depth = 0;
  let sawBrace = false;

  while (i < bodyEnd) {
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      i = skipped;
      continue;
    }
    const c = src[i]!;

    if (c === "(" || c === "[") {
      i = matchDelims(src, i, c, c === "(" ? ")" : "]");
      continue;
    }
    if (c === "{") {
      const close = matchDelims(src, i, "{", "}");
      sawBrace = true;
      i = close;
      // A method body at depth 0 terminates the member.
      if (depth === 0 && isMethodLike(src.slice(start, i))) {
        const semi = /^\s*;/.exec(src.slice(i, bodyEnd));
        return semi ? i + semi[0].length : i;
      }
      continue;
    }
    if (c === ";" && depth === 0) return i + 1;
    if (c === "\n" && depth === 0) {
      const rest = src.slice(start, i);
      if (
        rest.trim() &&
        !endsWithOperator(rest) &&
        (sawBrace || hasCompleteInitializer(rest))
      ) {
        const next = skipTrivia(src, i, bodyEnd);
        // A continuation line starting with an operator keeps the member open.
        if (next >= bodyEnd || !/^[.?:)\]},]/.test(src[next] ?? "")) return i;
      }
    }
    i++;
  }

  return bodyEnd;
}

function isMethodLike(text: string) {
  return /^\s*(?:[\w$]+\s+)*[\w$"'\]]+\s*(?:<[^>]*>)?\s*\([\s\S]*\)\s*(?::[\s\S]*?)?\s*\{/.test(
    text,
  );
}

function endsWithOperator(text: string) {
  return /[=+\-*/%&|^!<>,.?:]\s*$/.test(text.replace(/\/\/[^\n]*$/, ""));
}

function hasCompleteInitializer(text: string) {
  return /=/.test(text) && isBalanced(text);
}

function classifyMember(
  text: string,
  leading: string,
  blankBefore: boolean,
): ClassMember {
  const modifiers: string[] = [];
  let rest = text;

  for (;;) {
    const match = /^([\w$]+)\s+/.exec(rest);
    if (!match || !MODIFIERS.includes(match[1]!)) break;
    // `static = 1` / `async = 1` are property names, not modifiers.
    if (/^\s*[=:(]/.test(rest.slice(match[1]!.length))) break;
    modifiers.push(match[1]!);
    rest = rest.slice(match[0].length);
  }

  const unsupported = (reason: string): ClassMember => ({
    kind: "unsupported",
    blankBefore,
    leading,
    text,
    modifiers,
    reason,
  });

  if (modifiers.includes("static")) {
    return unsupported("static members have no config equivalent");
  }
  if (rest.startsWith("#")) {
    return unsupported("private fields have no config equivalent");
  }
  if (/^constructor\s*\(/.test(rest)) {
    return unsupported("constructors have no config equivalent");
  }
  if (!isBalanced(text)) {
    return unsupported("could not be parsed (unbalanced brackets)");
  }

  const accessor = /^(get|set)\s+/.exec(rest);
  const nameMatch = /^(?:(?:get|set)\s+)?(\*\s*)?([\w$]+|"[^"]*"|'[^"]*')/.exec(
    rest,
  );
  if (!nameMatch) return unsupported("unrecognised member syntax");
  const name = nameMatch[2]!;
  const afterName = rest.slice(nameMatch[0].length).replace(/^[?!]/, "");

  if (/^\s*(<|\()/.test(afterName)) {
    return {
      kind: accessor ? "accessor" : "method",
      blankBefore,
      leading,
      text,
      name,
      modifiers,
      signature: rest.replace(/;\s*$/, ""),
    };
  }

  const eq = findTopLevelEquals(rest);
  if (eq === -1) {
    return unsupported(
      "declaration without an initializer — nothing to carry over",
    );
  }

  const value = rest
    .slice(eq + 1)
    .replace(/;\s*$/, "")
    .trim();

  return {
    kind: "property",
    blankBefore,
    leading,
    text,
    name,
    modifiers,
    value,
  };
}

function findTopLevelEquals(text: string): number {
  let i = 0;
  while (i < text.length) {
    const skipped = skipAtomic(text, i);
    if (skipped !== null && skipped > i) {
      i = skipped;
      continue;
    }
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") {
      i = matchDelims(text, i, c, c === "(" ? ")" : c === "[" ? "]" : "}");
      continue;
    }
    if (c === "<") {
      // Generic type argument list in an annotation.
      const close = matchDelims(text, i, "<", ">");
      if (close > i + 1) {
        i = close;
        continue;
      }
    }
    if (c === "=" && text[i + 1] !== "=" && text[i - 1] !== "=") return i;
    i++;
  }
  return -1;
}
