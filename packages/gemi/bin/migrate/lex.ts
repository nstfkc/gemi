// Minimal source scanner used by the `gemi migrate` codemod.
//
// The codemod is deliberately text-preserving: it rewrites the handful of
// tokens that changed between 0.42 and 0.43 and leaves every comment, blank
// line and formatting decision exactly where the app author put it. A full
// parse-and-print round trip would reformat whole files and throw away the
// comments that make a config file readable, so instead we scan just far enough
// to find member boundaries and splice around them.
//
// Known limitation: regex literals are not recognised. A `/` is always read as
// an operator, so a regex containing an unbalanced brace or quote would confuse
// the scanner. `isBalanced` guards against that — a member that does not come
// out brace-balanced is reported as untranslatable rather than mangled.

/**
 * If `i` sits on a string, template literal or comment, returns the index just
 * past it. Returns `null` otherwise, meaning "this is an ordinary character".
 */
export function skipAtomic(src: string, i: number): number | null {
  const c = src[i];

  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === c) return j + 1;
      if (src[j] === "\n") return j; // unterminated; bail on the line
      j++;
    }
    return src.length;
  }

  if (c === "`") {
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

  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }

  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 2;
  }

  return null;
}

/**
 * `openIdx` must point at `open`. Returns the index just past its match.
 */
export function matchDelims(
  src: string,
  openIdx: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      i = skipped;
      continue;
    }
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

/** Advances past whitespace and comments. */
export function skipTrivia(src: string, i: number, end = src.length): number {
  while (i < end) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const skipped = skipAtomic(src, i);
      if (skipped === null || skipped <= i) return i;
      i = skipped;
      continue;
    }
    return i;
  }
  return i;
}

/** Whitespace only — comments are trivia we want to keep attached to members. */
export function skipWhitespace(src: string, i: number, end = src.length) {
  while (i < end && /\s/.test(src[i] ?? "")) i++;
  return i;
}

/**
 * Brackets balance outside of strings/comments. Used as a sanity check on any
 * span the scanner is about to rewrite.
 */
export function isBalanced(src: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let i = 0;
  while (i < src.length) {
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      i = skipped;
      continue;
    }
    const c = src[i]!;
    if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== pairs[c]) return false;
    }
    i++;
  }
  return stack.length === 0;
}

/** Re-indents every line but the first by `spaces`. */
export function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line, idx) => (idx === 0 || line.trim() === "" ? line : pad + line))
    .join("\n");
}

/** Word-boundary identifier replacement that ignores strings and comments. */
export function renameIdentifier(
  src: string,
  from: string,
  to: string,
): string {
  let out = "";
  let i = 0;
  let last = 0;
  while (i < src.length) {
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      i = skipped;
      continue;
    }
    if (
      src.startsWith(from, i) &&
      !/[\w$]/.test(src[i - 1] ?? "") &&
      !/[\w$]/.test(src[i + from.length] ?? "")
    ) {
      out += src.slice(last, i) + to;
      i += from.length;
      last = i;
      continue;
    }
    i++;
  }
  return out + src.slice(last);
}
