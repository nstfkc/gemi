/**
 * Dev-mode guard against the silent no-JS blanking threshold (#289, #294).
 *
 * React defers any boundary bigger than `progressiveChunkSize` (~12.8 kB) out
 * of the shell on size alone, so a public page that reads fine without JS
 * today goes blank the day one more section pushes it over the budget — its
 * content is parked in `<div hidden>` segments revealed by `$RC()` scripts,
 * and nothing in typecheck, tests, or CI notices the transition. `"no-stream"`
 * fixes it, but only for routes someone already knows are affected.
 *
 * The measurement is nearly free where the bytes already flow: the stream
 * injector is the last thing to see the response body, so an observer hung on
 * its `onChunk` hook holds the document exactly as the visitor received it.
 * After the body closes, the bytes are split into shell-readable text (what a
 * no-JS reader can see) versus deferred text (parked behind reveal scripts),
 * and a route shipping its content deferred while its shell is near-blank gets
 * a console hint — once per route per boot.
 */

export interface ShellContentMeasurement {
  /** Non-whitespace text chars a no-JS reader can see in the shell. */
  shellChars: number;
  /** Non-whitespace text chars parked in `<div hidden>` reveal segments. */
  deferredChars: number;
}

/**
 * Their text is code, styling, or metadata — never readable content. React's
 * `<template id="B:...">` fallback markers are empty anyway; skipping the tag
 * also covers hand-written templates.
 */
const RAW_TEXT_TAGS = new Set(["script", "style", "template", "title"]);

/**
 * `hidden` as a standalone attribute (`<div hidden id="S:0">`, `hidden=""`).
 * Tested against the tag with its quoted attribute values blanked out
 * (`QUOTED_VALUE` below), so the word `hidden` inside a value — a Tailwind
 * list like `class="mt-2 hidden md:block"` or prose like
 * `title="show hidden files"` — never opens a deferred segment.
 */
const HIDDEN_ATTR = /\shidden([\s=/]|$)/i;

/**
 * Quoted attribute values, to be blanked before the `HIDDEN_ATTR` test. Safe
 * as a regex because React escapes `"` and `'` inside attribute values, so a
 * quoted span never contains its own delimiter.
 */
const QUOTED_VALUE = /"[^"]*"|'[^']*'/g;

/**
 * Splits a streamed HTML document into shell-readable versus deferred text.
 *
 * A scanner, not a parser: it only needs to tell text from markup, skip the
 * tags whose text is never content, and track `<div hidden>` nesting — the
 * container React streams deferred segments in. Attribute text and comments
 * (including React's `<!--$?-->` boundary marks) never count; whitespace
 * never counts.
 */
export function measureShellContent(html: string): ShellContentMeasurement {
  let shellChars = 0;
  let deferredChars = 0;
  /** `<div>` nesting depth inside the current hidden segment; 0 = in the shell. */
  let hiddenDepth = 0;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > i) {
      const visible = html.slice(i, textEnd).replace(/\s+/g, "").length;
      if (hiddenDepth > 0) {
        deferredChars += visible;
      } else {
        shellChars += visible;
      }
    }
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }

    const gt = html.indexOf(">", lt);
    if (gt === -1) break; // truncated tag — nothing readable follows
    const tag = html.slice(lt + 1, gt);
    i = gt + 1;

    const name = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name) continue;
    const isClosing = tag.startsWith("/");

    if (!isClosing && RAW_TEXT_TAGS.has(name) && !tag.endsWith("/")) {
      const close = html.indexOf(`</${name}`, i);
      i = close === -1 ? html.length : close;
      continue;
    }

    // Only `div` is tracked because that is the container React streams
    // deferred segments in. A hand-written `<section hidden>` still counts as
    // shell text — a false negative (stays silent), never a false hint.
    if (name !== "div") continue;
    if (isClosing) {
      if (hiddenDepth > 0) hiddenDepth -= 1;
    } else if (hiddenDepth > 0) {
      hiddenDepth += 1;
    } else if (HIDDEN_ATTR.test(tag.replace(QUOTED_VALUE, '""'))) {
      hiddenDepth = 1;
    }
  }

  return { shellChars, deferredChars };
}

/** Below this much deferred text the page isn't relying on reveal scripts. */
export const DEFERRED_TEXT_FLOOR = 1000;

/**
 * "Near zero": under this many readable chars the shell is effectively blank
 * — less than a sentence, no headline worth of content.
 */
export const SHELL_TEXT_NEAR_ZERO = 64;

function formatChars(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)} kB` : `${chars} chars`;
}

/**
 * The hint for a route whose content streams behind reveal scripts while its
 * shell is near-blank — exactly the transition #289 was discovered through by
 * hand-measuring. Null when the measurement is fine: a shell that carries its
 * own text, or too little deferred text to matter.
 */
export function shellContentHint(
  routePath: string,
  measurement: ShellContentMeasurement,
): string | null {
  if (measurement.deferredChars < DEFERRED_TEXT_FLOOR) return null;
  if (measurement.shellChars >= SHELL_TEXT_NEAR_ZERO) return null;
  return (
    `[gemi] GET ${routePath} streams ${formatChars(measurement.deferredChars)} of its ` +
    `content behind reveal scripts — a no-JS visitor sees ~${measurement.shellChars} chars. ` +
    `If this is a public/content route, add "no-stream" to its middleware.`
  );
}

/**
 * Owns the once-per-route-per-boot dedup (#294's "logs the hint once"): a hot
 * route must not spam the dev console, but a route whose measurement is
 * healthy today must stay eligible for the hint the day it crosses the
 * threshold — only an actually-emitted hint marks the route as done.
 *
 * `warn` is injectable for tests; production callers use the default.
 */
export function createShellContentReporter(warn: (hint: string) => void = console.warn) {
  /** Routes already hinted this boot. */
  const hintedRoutes = new Set<string>();
  return {
    /**
     * Whether collecting bytes for this route can still lead to a hint —
     * false once the route has been hinted, so the caller can skip the
     * observer entirely.
     */
    shouldObserve(routePath: string): boolean {
      return !hintedRoutes.has(routePath);
    },
    report(routePath: string, measurement: ShellContentMeasurement): void {
      if (hintedRoutes.has(routePath)) return;
      const hint = shellContentHint(routePath, measurement);
      if (!hint) return;
      hintedRoutes.add(routePath);
      warn(hint);
    },
  };
}

export type ShellContentReporter = ReturnType<typeof createShellContentReporter>;

/**
 * Accumulates the response body for a post-close measurement. Wire `onChunk`
 * into `StreamLifecycleHooks.onChunk`; call `measure` once the body closed.
 * Decoding is streaming-safe — a multi-byte character split across chunks
 * still decodes as one character.
 */
export function createShellContentObserver() {
  const decoder = new TextDecoder();
  let html = "";
  return {
    onChunk(chunk: Uint8Array) {
      html += decoder.decode(chunk, { stream: true });
    },
    measure(): ShellContentMeasurement {
      html += decoder.decode();
      return measureShellContent(html);
    },
  };
}
