/** @vitest-environment node */
import { describe, expect, test } from "vitest";
import { createHtmlInsertionScanner } from "./htmlInsertionPoint";

const encoder = new TextEncoder();

/** Feed `html` (optionally split at the given byte offsets) and report the end state. */
function safeAfter(html: string, splits: number[] = []): boolean {
  const scanner = createHtmlInsertionScanner();
  const bytes = encoder.encode(html);
  let at = 0;
  for (const split of [...splits, bytes.length]) {
    scanner.write(bytes.subarray(at, split));
    at = split;
  }
  return scanner.isSafe();
}

/**
 * Where the scanner would splice a payload into `chunk`, having already
 * consumed `prefix`. Returned as the string cut at that offset, which reads
 * better in a failure than a bare number.
 */
function insertionPoint(prefix: string, chunk: string) {
  const scanner = createHtmlInsertionScanner();
  scanner.write(encoder.encode(prefix));
  const bytes = encoder.encode(chunk);
  const at = scanner.scanToInsertionPoint(bytes);
  return {
    at,
    before: new TextDecoder().decode(bytes.subarray(0, at)),
    after: new TextDecoder().decode(bytes.subarray(at)),
    safe: scanner.isSafe(),
  };
}

describe("createHtmlInsertionScanner", () => {
  test("a complete document ends between elements", () => {
    expect(safeAfter("<!doctype html><html><body><p>hi</p></body></html>")).toBe(
      true,
    );
  });

  test.each([
    ["mid-tag-name", "<div><spa"],
    ["before an attribute", "<div><link rel"],
    ["inside a quoted attribute value", '<link rel="modulepre'],
    ["inside a single-quoted attribute value", "<link rel='modulepre"],
    ["after an attribute value, still in the tag", '<link rel="preload" '],
    ["just after the opening `<`", "<p>text<"],
    ["inside a comment", "<div><!-- unfinished"],
    ["inside a comment ending in a single dash", "<div><!-- almost -"],
    ["inside a doctype", "<!DOCTYPE htm"],
    ["inside a script body", "<script>var x = 1;"],
    ["inside a style body", '<style type="text/css">.a{color:red}'],
    ["inside a title", "<title>Pricing"],
    ["inside a textarea", "<textarea>hello"],
    ["inside noscript, which is raw text when scripting is on", "<noscript><p>"],
    ["inside an end tag", "<script>x</script"],
    ["on a partial end-tag match", "<script>x</scr"],
    ["on a same-name-prefixed element inside raw text", "<script>'</scriptx>'"],
  ])("reports unsafe %s", (_label, html) => {
    expect(safeAfter(html)).toBe(false);
  });

  test.each([
    ["a closed tag", "<div><link rel=\"preload\" href='/a.js'/>"],
    ["a closed comment", "<div><!-- done -->"],
    ["a comment closed with extra dashes", "<div><!-- done --->"],
    ["a closed doctype", "<!DOCTYPE html>"],
    ["a closed script", "<script>var x = 1;</script>"],
    ["a script closed with whitespace in the end tag", "<script>x</script >"],
    ["a closed style", "<style>.a{color:red}</style>"],
    ["text between elements", "<p>some text"],
    ["a lone `<` that opens nothing", "<p>5 < 6 and"],
    ["an already-injected payload script", "<div></div><script>(self.x=1)</script>"],
  ])("reports safe after %s", (_label, html) => {
    expect(safeAfter(html)).toBe(true);
  });

  test.each([
    // `<template>` content is parsed into a DocumentFragment, where a script
    // never runs — and React emits one per Suspense boundary.
    ["inside a template", "<main><template id='B:0'>"],
    ["inside a template holding markup", "<template><div>x</div>"],
    ["inside a nested template", "<template><template></template>"],
    // Foreign content: a spliced script lands in the MathML/SVG namespace.
    ["inside math", "<p><math>"],
    ["inside math, past a child", "<math><mi>x</mi>"],
    ["inside svg", "<div><svg viewBox='0 0 1 1'>"],
    ["inside svg, past a self-closed child", "<svg><path d='M0 0'/>"],
    ["inside nested svg", "<svg><svg>"],
  ])("reports unsafe %s", (_label, html) => {
    expect(safeAfter(html)).toBe(false);
  });

  test.each([
    ["a closed template", "<main><template id='B:0'></template>"],
    ["a closed template holding markup", "<template><div>x</div></template>"],
    ["closed nested templates", "<template><template></template></template>"],
    ["closed math", "<p><math><mi>x</mi></math>"],
    ["closed svg", "<div><svg><path d='M0 0'/></svg>"],
    // Foreign content honours `/>`, so the subtree never opens.
    ["a self-closed svg", "<div><svg/>"],
    ["a self-closed math", "<p><math/>"],
  ])("reports safe after %s", (_label, html) => {
    expect(safeAfter(html)).toBe(true);
  });

  test("`/ >` does not self-close, so the subtree still opens", () => {
    expect(safeAfter("<div><svg / >")).toBe(false);
    expect(safeAfter("<div><svg / ></svg>")).toBe(true);
  });

  test("a stray end tag cannot drive a depth counter negative", () => {
    // Otherwise one unbalanced `</template>` would make every later template
    // look closed, re-opening the hole this guards.
    expect(safeAfter("</template></svg></math><p>x")).toBe(true);
    expect(safeAfter("</template></svg><template>")).toBe(false);
    expect(safeAfter("</math><svg>")).toBe(false);
  });

  test("React's Suspense boundary template is not an insertion point", () => {
    // The exact markup react-dom 19 emits around a streamed fallback.
    const point = insertionPoint(
      "<main><!--$?--><template id=\"B",
      ':0"></template><div>skeleton</div><!--/$--></main>',
    );
    expect(point.before).toBe(':0"></template>');
    expect(point.after).toBe("<div>skeleton</div><!--/$--></main>");
    expect(point.safe).toBe(true);
  });

  test("state survives a split anywhere, including mid-token", () => {
    const html = '<div><!-- c --><script>a="</scriptx>"</script><p>x</p>';
    for (let split = 0; split <= html.length; split++) {
      expect(safeAfter(html, [split])).toBe(true);
    }
    // …and the same document truncated mid-`<script>` is unsafe at every split.
    const open = '<div><script>a="';
    for (let split = 0; split <= open.length; split++) {
      expect(safeAfter(open, [split])).toBe(false);
    }
  });

  test("a chunk that resumes mid-tag splices after that tag, not at offset 0", () => {
    // The exact shape from #404: React's view filled up inside a `<link>`.
    const point = insertionPoint(
      '<head><link rel="modulepre',
      'load" href="/assets/dist.js"/><link rel="modulepreload" href="/b.js"/>',
    );
    expect(point.before).toBe('load" href="/assets/dist.js"/>');
    expect(point.after).toBe('<link rel="modulepreload" href="/b.js"/>');
    expect(point.safe).toBe(true);
  });

  test("a chunk that starts between elements splices at offset 0", () => {
    const point = insertionPoint("<head><title>x</title>", "<link href='/a.js'/>");
    expect(point.at).toBe(0);
    expect(point.safe).toBe(true);
  });

  test("a chunk with no safe offset is consumed whole and reports unsafe", () => {
    const chunk = "a".repeat(64);
    const point = insertionPoint("<style>", chunk);
    expect(point.at).toBe(chunk.length);
    expect(point.safe).toBe(false);
  });

  test("multi-byte characters split across chunks do not confuse the scan", () => {
    const bytes = encoder.encode("<p>çğüşiöñ — ✓</p><div>");
    const scanner = createHtmlInsertionScanner();
    // Split inside the em-dash's UTF-8 sequence.
    const mid = bytes.indexOf(0xe2) + 1;
    scanner.write(bytes.subarray(0, mid));
    scanner.write(bytes.subarray(mid));
    expect(scanner.isSafe()).toBe(true);
  });
});
