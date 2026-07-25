/**
 * RFC 7233 byte-range parsing and resolution.
 *
 * Deliberately dependency-free: the file storage drivers import `ByteRange`
 * from here, and drivers otherwise import nothing out of `http/`.
 */

/**
 * A parsed but *unresolved* `Range` header. The suffix form carries no absolute
 * offsets — resolving it needs the total size of the object.
 */
export type ByteRange =
  | { kind: "offset"; start: number; end: number | null }
  | { kind: "suffix"; suffixLength: number };

/** Absolute, inclusive, clamped-to-the-object byte offsets. */
export type ResolvedRange = { start: number; end: number; length: number };

/** A parsed response `Content-Range` of the `bytes S-E/TOTAL` form. */
export type ContentRange = { start: number; end: number; total: number };

function parseInteger(raw: string): number | null {
  // Reject anything that isn't a run of ASCII digits. `Number()` would happily
  // take "0x10", " 5", "1e3" and "+5", none of which are valid byte-pos.
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parses a request `Range` header.
 *
 * Returns `null` for anything we cannot or will not serve as a partial
 * response. That is not an error path: RFC 7233 §3.1 requires a recipient to
 * ignore a `Range` it does not understand, and §4.1 lets a server ignore one it
 * does. Every `null` here means "serve the complete representation with 200".
 *
 * Only a single range is supported — we never emit `multipart/byteranges`, so a
 * multi-range request is ignored rather than partially honoured.
 */
export function parseRangeHeader(
  header: string | null | undefined,
): ByteRange | null {
  if (!header) {
    return null;
  }

  const trimmed = header.trim();
  if (!/^bytes=/i.test(trimmed)) {
    return null;
  }

  const specs = trimmed
    .slice("bytes=".length)
    .split(",")
    .map((spec) => spec.trim());

  // A single trailing comma is tolerated ("bytes=0-9,") because some clients
  // emit it. More than one *non-empty* spec is a genuine multi-range request.
  const present = specs.filter((spec) => spec !== "");
  if (present.length !== 1) {
    return null;
  }

  const spec = present[0];
  const separator = spec.indexOf("-");
  if (separator === -1) {
    return null;
  }

  const rawStart = spec.slice(0, separator);
  const rawEnd = spec.slice(separator + 1);

  if (rawStart === "") {
    // Suffix form: `bytes=-N`, the last N bytes.
    const suffixLength = parseInteger(rawEnd);
    if (suffixLength === null) {
      return null;
    }
    // `bytes=-0` parses cleanly and resolves to unsatisfiable (416). Collapsing
    // it to `null` here would serve the whole file instead, which the spec does
    // not allow. Satisfiability is `resolveRange`'s job alone.
    return { kind: "suffix", suffixLength };
  }

  const start = parseInteger(rawStart);
  if (start === null) {
    return null;
  }

  if (rawEnd === "") {
    return { kind: "offset", start, end: null };
  }

  const end = parseInteger(rawEnd);
  if (end === null || end < start) {
    return null;
  }

  return { kind: "offset", start, end };
}

/**
 * Resolves a parsed range against a known total size.
 *
 * Returns `null` when the range is unsatisfiable, which the caller must turn
 * into a 416 rather than a full response.
 */
export function resolveRange(
  range: ByteRange,
  total: number,
): ResolvedRange | null {
  // An empty (or unknown-length) representation has no satisfiable range at
  // all. Handling it here is what keeps `bytes 0--1/0` from ever being built.
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }

  let start: number;
  let end: number;

  if (range.kind === "suffix") {
    if (range.suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, total - range.suffixLength);
    end = total - 1;
  } else {
    if (range.start >= total) {
      return null;
    }
    start = range.start;
    // An end past the last byte is clamped, not rejected — Chrome routinely
    // asks for `bytes=0-2147483647` when loading a <video>.
    end = range.end === null ? total - 1 : Math.min(range.end, total - 1);
    if (end < start) {
      return null;
    }
  }

  return { start, end, length: end - start + 1 };
}

/** Renders a range back into a `Range` request header for a storage backend. */
export function toRangeHeaderValue(range: ByteRange): string {
  if (range.kind === "suffix") {
    return `bytes=-${range.suffixLength}`;
  }
  return range.end === null
    ? `bytes=${range.start}-`
    : `bytes=${range.start}-${range.end}`;
}

/**
 * Parses a response `Content-Range`. Storage backends report the authoritative
 * total size of the object here on a ranged read, which is what lets a driver
 * answer a range without a second round trip for the size.
 *
 * The unsatisfied form used on a 416 has no offsets and returns `null`.
 */
export function parseContentRange(
  value: string | null | undefined,
): ContentRange | null {
  if (!value) {
    return null;
  }
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const start = parseInteger(match[1]);
  const end = parseInteger(match[2]);
  const total = parseInteger(match[3]);
  if (start === null || end === null || total === null || end < start) {
    return null;
  }
  return { start, end, total };
}

export function formatContentRange(
  start: number,
  end: number,
  total: number,
): string {
  return `bytes ${start}-${end}/${total}`;
}

/** The `Content-Range` of a 416: no offsets, just the current total size. */
export function formatUnsatisfiedContentRange(total: number): string {
  return `bytes */${total}`;
}
