import { describe, expect, test } from "vitest";
import { PartialJsonParser, parsePartialJson } from "./partialJson";

// The lenient, incremental parser behind `generate({ onPartial })` (#1149).

describe("parsePartialJson", () => {
  test("a whole document parses as JSON.parse does", () => {
    const doc = {
      a: "x",
      n: -1.5e3,
      z: 0,
      t: true,
      f: false,
      u: null,
      list: [1, [2, {}], { b: "c" }],
      "odd key": 'é\n\t"q"\\ 😀',
    };
    expect(parsePartialJson(JSON.stringify(doc))).toEqual(doc);
    expect(parsePartialJson(JSON.stringify(doc, null, 2))).toEqual(doc);
  });

  test("nothing usable is undefined", () => {
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson("   ")).toBeUndefined();
    // A lone number may still grow.
    expect(parsePartialJson("12")).toBeUndefined();
    expect(parsePartialJson("12 ")).toBe(12);
    expect(parsePartialJson("tr")).toBeUndefined();
  });

  test("open strings, objects and arrays are closed", () => {
    expect(parsePartialJson("{")).toEqual({});
    expect(parsePartialJson("[")).toEqual([]);
    expect(parsePartialJson('{"title": "Hel')).toEqual({ title: "Hel" });
    expect(parsePartialJson('{"title": "')).toEqual({ title: "" });
    expect(parsePartialJson('{"a": {"b": [{"c": "d')).toEqual({
      a: { b: [{ c: "d" }] },
    });
    expect(parsePartialJson('["a", "b')).toEqual(["a", "b"]);
    expect(parsePartialJson('"top')).toBe("top");
  });

  test("a half-written key is dropped, and a key whose value has not started", () => {
    expect(parsePartialJson('{"a": "x", "ti')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a": "x", "title"')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a": "x", "title":')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a": "x", "title": ')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a": "x",')).toEqual({ a: "x" });
  });

  test("a number appears only once something follows it", () => {
    expect(parsePartialJson('{"n": 12')).toEqual({});
    expect(parsePartialJson('{"n": 12,')).toEqual({ n: 12 });
    expect(parsePartialJson('{"n": 12}')).toEqual({ n: 12 });
    expect(parsePartialJson("[1, 2, 3")).toEqual([1, 2]);
    expect(parsePartialJson("[1, 2, -")).toEqual([1, 2]);
    expect(parsePartialJson("[1.5e")).toEqual([]);
  });

  test("a half-written literal is dropped; a whole one is kept at once", () => {
    expect(parsePartialJson('{"done": tr')).toEqual({});
    expect(parsePartialJson('{"done": true')).toEqual({ done: true });
    expect(parsePartialJson("[null, fals")).toEqual([null]);
  });

  test("a half-written escape is left out of an open string", () => {
    expect(parsePartialJson('["a\\')).toEqual(["a"]);
    expect(parsePartialJson('["a\\\\')).toEqual(["a\\"]);
    expect(parsePartialJson('["a\\u00')).toEqual(["a"]);
    expect(parsePartialJson('["a\\u00e9')).toEqual(["aé"]);
    // The first half of a surrogate pair waits for the second.
    expect(parsePartialJson('["a\\ud83d')).toEqual(["a"]);
    expect(parsePartialJson('["a\\ud83d\\ude00')).toEqual(["a😀"]);
    expect(parsePartialJson('["say \\"hi')).toEqual(['say "hi']);
  });

  test("text that stops being JSON keeps what was read", () => {
    expect(parsePartialJson('{"a": "x", "b": oops')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a": 1} trailing')).toEqual({ a: 1 });
    expect(parsePartialJson("[1 2]")).toEqual([1]);
    expect(parsePartialJson("[01]")).toEqual([]);
  });

  test("__proto__ is an own key, as in JSON.parse", () => {
    const value = parsePartialJson('{"__proto__": {"polluted": true}, "x": "') as any;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__", "x"]);
    expect(({} as any).polluted).toBeUndefined();
  });

  test("any split of a document reaches the same value", () => {
    const text = JSON.stringify({
      a: [1, "two", { three: [true, null] }],
      "b c": "d\\e",
    });
    for (let size = 1; size <= 5; size++) {
      const parser = new PartialJsonParser();
      for (let i = 0; i < text.length; i += size) parser.push(text.slice(i, i + size));
      expect(parser.snapshot()).toEqual(JSON.parse(text));
    }
  });
});

describe("PartialJsonParser", () => {
  test("closed lists the containers each piece finished, outermost last", () => {
    const parser = new PartialJsonParser();
    expect(parser.push('{"items": [{"id": 1}, {"id"')).toEqual(["$.items[0]"]);
    expect(parser.push(": 2}")).toEqual(["$.items[1]"]);
    expect(parser.push(', []], "my key": {"x": {}')).toEqual([
      "$.items[2]",
      "$.items",
      '$["my key"].x',
    ]);
    expect(parser.push("}}")).toEqual(['$["my key"]', "$"]);
    expect(parser.push("  ")).toEqual([]);
  });

  test("a top-level array's paths", () => {
    const parser = new PartialJsonParser();
    expect(parser.push('[[1], {"a": [')).toEqual(["$[0]"]);
    expect(parser.push("]}]")).toEqual(["$[1].a", "$[1]", "$"]);
  });

  test("changed says whether the value moved since the last snapshot", () => {
    const parser = new PartialJsonParser();
    parser.push('{"a');
    // `{` opened the object.
    expect(parser.changed).toBe(true);
    expect(parser.snapshot()).toEqual({});
    parser.push('": 1');
    expect(parser.changed).toBe(false);
    parser.push(", ");
    expect(parser.changed).toBe(true);
    expect(parser.snapshot()).toEqual({ a: 1 });
    parser.push('"b": "x');
    expect(parser.changed).toBe(true);
    expect(parser.snapshot()).toEqual({ a: 1, b: "x" });
    // Half an escape shows nothing new.
    parser.push("\\u00");
    expect(parser.changed).toBe(false);
    parser.push('e9"');
    expect(parser.changed).toBe(true);
    expect(parser.snapshot()).toEqual({ a: 1, b: "xé" });
    // Closing the object changes no value.
    parser.push("}");
    expect(parser.changed).toBe(false);
  });

  test("a closed subtree is shared between snapshots, an open one is copied", () => {
    const parser = new PartialJsonParser();
    parser.push('{"done": {"a": 1}, "open": [');
    const first = parser.snapshot() as any;
    parser.push('"x"');
    const second = parser.snapshot() as any;
    expect(second.done).toBe(first.done);
    expect(first.open).toEqual([]);
    expect(second.open).toEqual(["x"]);
  });
});
