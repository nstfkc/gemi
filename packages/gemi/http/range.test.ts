import { describe, expect, test } from "vitest";

import {
  formatContentRange,
  formatUnsatisfiedContentRange,
  parseContentRange,
  parseRangeHeader,
  resolveRange,
  toRangeHeaderValue,
  type ByteRange,
} from "./range";

describe("parseRangeHeader()", () => {
  test("parses the offset forms", () => {
    expect(parseRangeHeader("bytes=0-499")).toEqual({
      kind: "offset",
      start: 0,
      end: 499,
    });
    expect(parseRangeHeader("bytes=200-")).toEqual({
      kind: "offset",
      start: 200,
      end: null,
    });
    expect(parseRangeHeader("bytes=0-0")).toEqual({
      kind: "offset",
      start: 0,
      end: 0,
    });
  });

  test("parses the suffix form", () => {
    expect(parseRangeHeader("bytes=-500")).toEqual({
      kind: "suffix",
      suffixLength: 500,
    });
  });

  test("keeps `bytes=-0` distinct from an absent range", () => {
    // It parses, then resolves to unsatisfiable. Collapsing it to null here
    // would serve the whole representation, which RFC 7233 disallows.
    expect(parseRangeHeader("bytes=-0")).toEqual({
      kind: "suffix",
      suffixLength: 0,
    });
    expect(resolveRange(parseRangeHeader("bytes=-0")!, 100)).toBeNull();
  });

  test("is case insensitive in the unit and tolerates surrounding whitespace", () => {
    expect(parseRangeHeader("BYTES=0-9")).toEqual({
      kind: "offset",
      start: 0,
      end: 9,
    });
    expect(parseRangeHeader("  bytes=0-9  ")).toEqual({
      kind: "offset",
      start: 0,
      end: 9,
    });
    expect(parseRangeHeader("bytes= 0-9")).toEqual({
      kind: "offset",
      start: 0,
      end: 9,
    });
  });

  test("tolerates a single trailing comma", () => {
    expect(parseRangeHeader("bytes=0-9,")).toEqual({
      kind: "offset",
      start: 0,
      end: 9,
    });
  });

  // Everything below must be ignored, meaning the caller serves a full 200.
  test.each([
    ["absent", null],
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["unknown unit", "items=0-5"],
    ["missing equals", "bytes 0-5"],
    ["no separator", "bytes=5"],
    ["empty spec", "bytes="],
    ["bare separator", "bytes=-"],
    ["non numeric", "bytes=a-b"],
    ["non numeric end", "bytes=0-b"],
    ["inverted", "bytes=100-50"],
    ["multi range", "bytes=0-499,600-999"],
    ["three ranges", "bytes=0-1,2-3,4-5"],
    ["internal whitespace", "bytes=0 - 5"],
    ["signed", "bytes=+0-5"],
    ["float", "bytes=0.5-5"],
    ["hex", "bytes=0x10-0x20"],
    ["exponent", "bytes=1e3-2e3"],
    ["unsafe integer", `bytes=0-${Number.MAX_SAFE_INTEGER + 10}`],
  ])("ignores %s", (_label, header) => {
    expect(parseRangeHeader(header as string | null | undefined)).toBeNull();
  });
});

describe("resolveRange()", () => {
  const at = (header: string, total: number) =>
    resolveRange(parseRangeHeader(header)!, total);

  test("resolves offset ranges against a 100 byte object", () => {
    expect(at("bytes=0-", 100)).toEqual({ start: 0, end: 99, length: 100 });
    expect(at("bytes=0-49", 100)).toEqual({ start: 0, end: 49, length: 50 });
    expect(at("bytes=50-", 100)).toEqual({ start: 50, end: 99, length: 50 });
    expect(at("bytes=99-", 100)).toEqual({ start: 99, end: 99, length: 1 });
  });

  test("resolves suffix ranges", () => {
    expect(at("bytes=-30", 100)).toEqual({ start: 70, end: 99, length: 30 });
  });

  test("clamps a suffix longer than the object to the whole object", () => {
    expect(at("bytes=-500", 100)).toEqual({ start: 0, end: 99, length: 100 });
  });

  test("clamps an end past the last byte rather than rejecting it", () => {
    // Chrome asks for this when loading a <video>.
    expect(at("bytes=0-2147483647", 100)).toEqual({
      start: 0,
      end: 99,
      length: 100,
    });
  });

  test("rejects a start at or past the end", () => {
    expect(at("bytes=100-", 100)).toBeNull();
    expect(at("bytes=150-200", 100)).toBeNull();
  });

  test("rejects a zero length suffix", () => {
    expect(at("bytes=-0", 100)).toBeNull();
  });

  test("treats every range over an empty object as unsatisfiable", () => {
    // This is what stops `bytes 0--1/0` from ever being formatted.
    for (const header of ["bytes=0-", "bytes=0-0", "bytes=-1", "bytes=5-10"]) {
      expect(at(header, 0)).toBeNull();
    }
  });

  test("rejects a non finite total", () => {
    expect(resolveRange({ kind: "offset", start: 0, end: null }, NaN)).toBeNull();
  });
});

describe("toRangeHeaderValue()", () => {
  test.each([
    ["bytes=0-499", { kind: "offset", start: 0, end: 499 }],
    ["bytes=200-", { kind: "offset", start: 200, end: null }],
    ["bytes=-500", { kind: "suffix", suffixLength: 500 }],
  ])("round trips %s", (header, range) => {
    expect(toRangeHeaderValue(range as ByteRange)).toBe(header);
    expect(parseRangeHeader(header)).toEqual(range);
  });
});

describe("parseContentRange()", () => {
  test("parses the satisfied form", () => {
    expect(parseContentRange("bytes 100-199/12345")).toEqual({
      start: 100,
      end: 199,
      total: 12345,
    });
    expect(parseContentRange("bytes 0-0/1")).toEqual({
      start: 0,
      end: 0,
      total: 1,
    });
  });

  test.each([
    ["the unsatisfied form", "bytes */12345"],
    ["a missing total", "bytes 0-99"],
    ["an unknown unit", "items 0-99/100"],
    ["garbage", "not a content range"],
    ["an inverted range", "bytes 99-0/100"],
    ["empty", ""],
    ["null", null],
  ])("returns null for %s", (_label, value) => {
    expect(parseContentRange(value)).toBeNull();
  });
});

describe("formatters", () => {
  test("formatContentRange", () => {
    expect(formatContentRange(0, 99, 453730)).toBe("bytes 0-99/453730");
  });

  test("formatUnsatisfiedContentRange", () => {
    expect(formatUnsatisfiedContentRange(12345)).toBe("bytes */12345");
    expect(formatUnsatisfiedContentRange(0)).toBe("bytes */0");
  });
});
