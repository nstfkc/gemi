/**
 * Lenient, incremental parsing of a JSON document that is still arriving
 * (#1149): what `generate({ onPartial })` hands the caller after each delta,
 * and `parsePartialJson` for an app's own streams (tool-call arguments, say).
 *
 * WHAT "LENIENT" MEANS HERE. The value is the document so far with every open
 * string, object and array closed. What could still turn out to be something
 * else is left out: a key whose value has not started, a number (`12` may be
 * the start of `125`), and a half-written `true`/`false`/`null`. So a field
 * appears once its value has begun, and a number once something follows it.
 *
 * WHY NOT `bestEffortParse`. That one re-parses the whole text on every call,
 * which is fine for the agent's snapshot but quadratic for a long answer heard
 * delta by delta, and it cannot say which containers a delta closed. This one
 * keeps its place: `push` reads only the new text, and a snapshot copies only
 * the containers still open — closed ones are shared between snapshots.
 */

/** Every field optional, all the way down: what a partial answer can be. */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * The best parse of `text`, a JSON document that may be cut off anywhere.
 * Unterminated strings, objects and arrays are closed; a key with no value
 * yet, a number with nothing after it and a half-written literal are dropped.
 * `undefined` when nothing usable has arrived (empty text, a lone number), and
 * the value read so far when the text stops being JSON. Never throws.
 *
 *     parsePartialJson('{"title": "Hel')        // { title: "Hel" }
 *     parsePartialJson('{"items": [1, 2, 3')    // { items: [1, 2] }
 *     parsePartialJson('{"done": tr')           // {}
 */
export function parsePartialJson(text: string): unknown {
  const parser = new PartialJsonParser();
  parser.push(text);
  return parser.snapshot();
}

type Container = Record<string, unknown> | unknown[];

interface ObjectFrame {
  kind: "object";
  value: Record<string, unknown>;
  path: string;
  /** The key whose value is being read, once its colon has been. */
  key?: string;
  expect: "key-or-end" | "key" | "colon" | "value" | "comma-or-end";
}

interface ArrayFrame {
  kind: "array";
  value: unknown[];
  path: string;
  expect: "value-or-end" | "value" | "comma-or-end";
}

type Frame = ObjectFrame | ArrayFrame;

interface Scalar {
  kind: "string" | "number" | "literal";
  /** As written: a string's characters between the quotes, escapes included. */
  raw: string;
  /** A string that is an object key, not a value. */
  key: boolean;
  /** Inside a string, the previous character was an unescaped backslash. */
  escaped: boolean;
}

const LITERALS: Record<string, unknown> = {
  true: true,
  false: false,
  null: null,
};

/**
 * The incremental parser behind `parsePartialJson` and `onPartial`. `push`
 * feeds it the next piece of text and returns the paths of the arrays and
 * objects that piece closed; `snapshot` is the value so far; `changed` says
 * whether the value differs from the one the previous `snapshot` returned.
 */
export class PartialJsonParser {
  private frames: Frame[] = [];
  private scalar: Scalar | undefined;
  private root: unknown;
  private done = false;
  private failed = false;
  private dirty = false;
  // The open string value as the last snapshot showed it: a delta that only
  // adds half an escape sequence does not change it.
  private shownOpen: string | undefined;

  /** Reads `text` and returns the JSON paths (`$`, `$.items[0]`, …) of the
   *  arrays and objects it closed, outermost last. */
  push(text: string): string[] {
    const closed: string[] = [];
    for (let i = 0; i < text.length && !this.failed; i++) {
      this.read(text[i]!, closed);
    }
    return closed;
  }

  /** Whether the value changed since the last `snapshot()`. */
  get changed(): boolean {
    if (this.dirty) return true;
    const open = this.openStringValue();
    return open !== undefined && open !== this.shownOpen;
  }

  snapshot(): unknown {
    this.dirty = false;
    this.shownOpen = this.openStringValue();
    if (this.done) return this.root;
    if (this.frames.length === 0) return this.shownOpen;
    return this.build(0);
  }

  private build(index: number): unknown {
    const frame = this.frames[index]!;
    const child = index + 1 < this.frames.length ? this.build(index + 1) : this.openStringValue();
    if (frame.kind === "array") {
      const copy = frame.value.slice();
      if (child !== undefined) copy.push(child);
      return copy;
    }
    const copy = { ...frame.value };
    if (child !== undefined && frame.expect === "value" && frame.key !== undefined) {
      setProp(copy, frame.key, child);
    }
    return copy;
  }

  /** The decoded text of a string value still being written, if one is. */
  private openStringValue(): string | undefined {
    const scalar = this.scalar;
    if (!scalar || scalar.kind !== "string" || scalar.key) return undefined;
    return decodeString(trimIncompleteEscape(scalar.raw));
  }

  private read(char: string, closed: string[]): void {
    const scalar = this.scalar;
    if (scalar?.kind === "string") {
      if (scalar.escaped) {
        scalar.escaped = false;
      } else if (char === "\\") {
        scalar.escaped = true;
      } else if (char === '"') {
        this.scalar = undefined;
        const text = decodeString(scalar.raw);
        if (scalar.key) this.gotKey(text);
        // Visible already while open, unless its last characters came with
        // the closing quote. (A string opened since the last snapshot set
        // `dirty` when it started, so `shownOpen` is this string's.)
        else this.gotValue(text, text !== this.shownOpen);
        return;
      }
      scalar.raw += char;
      return;
    }
    if (scalar) {
      if (scalar.kind === "number" ? /[0-9eE+\-.]/.test(char) : /[a-z]/.test(char)) {
        scalar.raw += char;
        if (scalar.kind === "literal") this.checkLiteral(scalar);
        return;
      }
      // Whatever follows a number ends it; only then is it known whole.
      this.scalar = undefined;
      if (scalar.kind === "number") {
        const value = parseNumber(scalar.raw);
        if (value === undefined) return this.fail();
        this.gotValue(value, true);
      } else {
        return this.fail();
      }
      if (this.failed) return;
    }
    if (char === " " || char === "\n" || char === "\r" || char === "\t") return;

    const frame = this.frames[this.frames.length - 1];
    if (!frame) {
      if (this.done) return this.fail();
      return this.startValue(char, "$");
    }
    if (frame.kind === "object") {
      switch (frame.expect) {
        case "key-or-end":
        case "key":
          if (char === '"') {
            this.scalar = {
              kind: "string",
              raw: "",
              key: true,
              escaped: false,
            };
            return;
          }
          if (char === "}" && frame.expect === "key-or-end") return this.close(closed);
          return this.fail();
        case "colon":
          if (char === ":") {
            frame.expect = "value";
            return;
          }
          return this.fail();
        case "value":
          return this.startValue(char, childPath(frame.path, frame.key!));
        case "comma-or-end":
          if (char === ",") {
            frame.expect = "key";
            frame.key = undefined;
            return;
          }
          if (char === "}") return this.close(closed);
          return this.fail();
      }
    }
    switch (frame.expect) {
      case "value-or-end":
        if (char === "]") return this.close(closed);
        return this.startValue(char, `${frame.path}[${frame.value.length}]`);
      case "value":
        return this.startValue(char, `${frame.path}[${frame.value.length}]`);
      case "comma-or-end":
        if (char === ",") {
          frame.expect = "value";
          return;
        }
        if (char === "]") return this.close(closed);
        return this.fail();
    }
  }

  private startValue(char: string, path: string): void {
    if (char === "{") {
      this.frames.push({
        kind: "object",
        value: {},
        path,
        expect: "key-or-end",
      });
      this.dirty = true;
    } else if (char === "[") {
      this.frames.push({
        kind: "array",
        value: [],
        path,
        expect: "value-or-end",
      });
      this.dirty = true;
    } else if (char === '"') {
      this.scalar = { kind: "string", raw: "", key: false, escaped: false };
      // An empty string is already a value: the field appears.
      this.dirty = true;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      this.scalar = { kind: "number", raw: char, key: false, escaped: false };
    } else if (char >= "a" && char <= "z") {
      this.scalar = { kind: "literal", raw: char, key: false, escaped: false };
      this.checkLiteral(this.scalar);
    } else {
      this.fail();
    }
  }

  private checkLiteral(scalar: Scalar): void {
    if (scalar.raw in LITERALS) {
      this.scalar = undefined;
      this.gotValue(LITERALS[scalar.raw], true);
    } else if (!Object.keys(LITERALS).some((word) => word.startsWith(scalar.raw))) {
      this.fail();
    }
  }

  private gotKey(key: string): void {
    const frame = this.frames[this.frames.length - 1] as ObjectFrame;
    frame.key = key;
    frame.expect = "colon";
  }

  /** A finished value: attached to the open container, or the root. `visible`
   *  is whether the value was not already showing (a string was, open). */
  private gotValue(value: unknown, visible: boolean): void {
    if (visible) this.dirty = true;
    const frame = this.frames[this.frames.length - 1];
    if (!frame) {
      this.root = value;
      this.done = true;
    } else if (frame.kind === "array") {
      frame.value.push(value);
      frame.expect = "comma-or-end";
    } else {
      setProp(frame.value, frame.key!, value);
      frame.expect = "comma-or-end";
    }
  }

  private close(closed: string[]): void {
    const frame = this.frames.pop()!;
    closed.push(frame.path);
    // Already showing as an open container; closing it changes no value.
    this.gotValue(frame.value as Container, false);
  }

  /** Not JSON: keep what was read and ignore the rest. */
  private fail(): void {
    this.failed = true;
    this.scalar = undefined;
  }
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

// `__proto__` as a key is an own property in `JSON.parse`'s output, not the
// prototype; plain assignment would set the prototype instead.
function setProp(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

function parseNumber(raw: string): number | undefined {
  if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) return undefined;
  return Number(raw);
}

/** A string's raw characters, escapes decoded. A raw control character, which
 *  JSON forbids but a model may write, is kept as it is. */
function decodeString(raw: string): string {
  try {
    return JSON.parse(
      // oxlint-disable-next-line no-control-regex -- the control characters are the point
      `"${raw.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`,
    );
  } catch {
    return raw;
  }
}

/** An open string's raw text without a trailing half-written escape: a lone
 *  backslash, a `\u` with fewer than four digits, or the first half of a
 *  surrogate pair whose second half has not arrived. */
function trimIncompleteEscape(raw: string): string {
  const unicode = /\\u[0-9a-fA-F]{0,3}$/.exec(raw);
  if (unicode && isEscape(raw, unicode.index)) return raw.slice(0, unicode.index);
  const high = /\\u[dD][89abAB][0-9a-fA-F]{2}$/.exec(raw);
  if (high && isEscape(raw, high.index)) return raw.slice(0, high.index);
  if (raw.endsWith("\\") && isEscape(raw, raw.length - 1)) return raw.slice(0, -1);
  return raw;
}

/** Whether the backslash at `index` starts an escape (is not itself escaped). */
function isEscape(raw: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && raw[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}
