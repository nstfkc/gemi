/**
 * Tracks where an HTML byte stream *is* — mid-tag, inside a comment, inside a
 * `<script>` body, or between elements — so the stream injector only splices a
 * payload script in at a point the parser will read it as markup (#404).
 *
 * React's SSR stream copies into a fixed 2048-byte view and enqueues it when
 * full, so its chunk boundaries fall at arbitrary byte offsets — routinely
 * inside a tag. Splicing at one produced
 *
 *   <link rel="modulepre<script>(self.__GEMI_STREAM__=…)…</script>load" href="…"/>
 *
 * where the push script is swallowed as `<link>` attributes (so the payload
 * never reaches the client), the tail leaks as text, and the modulepreload is
 * lost.
 *
 * This is a byte scanner, not an HTML parser: it answers one question, "is the
 * output currently in the DATA state", and it only has to be conservative in
 * one direction. Reporting "not safe" when a splice would in fact have been
 * legal just defers the payload to the next opportunity; reporting "safe" when
 * it isn't is the bug. Ambiguous constructs therefore resolve to *unsafe*.
 *
 * Scanning bytes rather than decoded text is sound because every byte it keys
 * on (`<`, `>`, `"`, `'`, `/`, `!`, `-`) is ASCII, and no ASCII byte can appear
 * inside a multi-byte UTF-8 sequence. A chunk that splits a character mid-way
 * is therefore harmless.
 */

const TAB = 9;
const LF = 10;
const FF = 12;
const CR = 13;
const SPACE = 32;
const BANG = 33;
const DQUOTE = 34;
const SQUOTE = 39;
const DASH = 45;
const SLASH = 47;
const LT = 60;
const GT = 62;
const QUESTION = 63;

/**
 * Elements whose content is raw text or RCDATA — everything until the matching
 * end tag is text, so a `<script>` spliced inside one is never executed.
 * `<noscript>` is raw text exactly when scripting is enabled, which is the case
 * that matters here. `<plaintext>` is deliberately absent: it has no end tag,
 * so treating it as raw text would stall every later payload, and React never
 * emits it.
 */
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

type State =
  | "data"
  | "tagOpen"
  | "endTagOpen"
  | "tagName"
  | "inTag"
  | "attrDouble"
  | "attrSingle"
  | "bang"
  | "bogus"
  | "comment"
  | "rawText";

function isWhitespace(byte: number): boolean {
  return (
    byte === SPACE || byte === TAB || byte === LF || byte === FF || byte === CR
  );
}

function isAsciiAlpha(byte: number): boolean {
  return (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

/** ASCII lower-case; tag names are compared case-insensitively. */
function toLower(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

export interface HtmlInsertionScanner {
  /**
   * Consume `chunk`, stopping at the first byte offset where the output is in
   * the DATA state, and return that offset. Returns `chunk.length` if the whole
   * chunk was consumed without reaching DATA — the caller then forwards it
   * whole and asks again with the next one.
   *
   * The scanner's state always reflects exactly the bytes it consumed, so a
   * caller that stops short resumes by calling again with the remainder.
   */
  scanToInsertionPoint(chunk: Uint8Array): number;
  /** Consume `chunk` whole, for bytes forwarded without looking for a splice. */
  write(chunk: Uint8Array): void;
  /** Is the output, as of every byte consumed so far, between elements? */
  isSafe(): boolean;
}

export function createHtmlInsertionScanner(): HtmlInsertionScanner {
  let state: State = "data";
  /** Accumulated name of the tag currently being read. */
  let tagName = "";
  let isEndTag = false;
  /** `"</" + name` for the raw-text element being scanned past. */
  let closeSequence = "";
  /** How much of `closeSequence` the raw-text scan has matched so far. */
  let closeMatched = 0;
  /** Consecutive `-` bytes: two after `<!` open a comment, two before `>` close one. */
  let dashes = 0;

  const finishTag = () => {
    if (!isEndTag && RAW_TEXT_ELEMENTS.has(tagName)) {
      // A raw-text element's content is text, so nothing may be spliced into
      // it. `<script/>` does not self-close in HTML — browsers open a script
      // element either way — so the end tag is what gets us out.
      state = "rawText";
      closeSequence = `</${tagName}`;
      closeMatched = 0;
    } else {
      state = "data";
    }
    tagName = "";
  };

  const step = (byte: number) => {
    switch (state) {
      case "data":
        if (byte === LT) state = "tagOpen";
        return;

      case "tagOpen":
        if (byte === BANG) {
          state = "bang";
          dashes = 0;
        } else if (byte === SLASH) {
          state = "endTagOpen";
        } else if (isAsciiAlpha(byte)) {
          state = "tagName";
          isEndTag = false;
          tagName = String.fromCharCode(toLower(byte));
        } else if (byte === QUESTION) {
          // A bogus comment: consumed to the next `>`.
          state = "bogus";
        } else if (byte === LT) {
          // `<<` — the second `<` is the one that opens a tag.
          state = "tagOpen";
        } else {
          // `<` followed by anything else is literal text.
          state = "data";
        }
        return;

      case "endTagOpen":
        if (isAsciiAlpha(byte)) {
          state = "tagName";
          isEndTag = true;
          tagName = String.fromCharCode(toLower(byte));
        } else if (byte === GT) {
          state = "data";
        } else {
          state = "bogus";
        }
        return;

      case "tagName":
        if (isWhitespace(byte) || byte === SLASH) {
          state = "inTag";
        } else if (byte === GT) {
          finishTag();
        } else {
          tagName += String.fromCharCode(toLower(byte));
        }
        return;

      case "inTag":
        if (byte === GT) finishTag();
        else if (byte === DQUOTE) state = "attrDouble";
        else if (byte === SQUOTE) state = "attrSingle";
        return;

      case "attrDouble":
        if (byte === DQUOTE) state = "inTag";
        return;

      case "attrSingle":
        if (byte === SQUOTE) state = "inTag";
        return;

      case "bang":
        // `<!--` opens a comment; `<!DOCTYPE …` and anything else runs to `>`.
        if (byte === DASH) {
          dashes += 1;
          if (dashes === 2) {
            state = "comment";
            dashes = 0;
          }
        } else if (byte === GT) {
          state = "data";
        } else {
          state = "bogus";
        }
        return;

      case "bogus":
        if (byte === GT) state = "data";
        return;

      case "comment":
        if (byte === DASH) {
          // `--->` closes too, so the count saturates rather than resetting.
          dashes = dashes < 2 ? dashes + 1 : 2;
        } else if (byte === GT && dashes >= 2) {
          state = "data";
          dashes = 0;
        } else {
          dashes = 0;
        }
        return;

      case "rawText": {
        if (closeMatched < closeSequence.length) {
          if (toLower(byte) === closeSequence.charCodeAt(closeMatched)) {
            closeMatched += 1;
          } else {
            // `<` only ever appears at index 0 of `</name`, so a mismatch can
            // only restart the match on a `<`.
            closeMatched = byte === LT ? 1 : 0;
          }
          return;
        }
        // `</name` only ends the element when a tag-name delimiter follows —
        // `</scriptx>` is text, not an end tag.
        if (byte === GT) {
          state = "data";
          tagName = "";
        } else if (isWhitespace(byte) || byte === SLASH) {
          state = "inTag";
          tagName = "";
        } else {
          closeMatched = byte === LT ? 1 : 0;
        }
        return;
      }
    }
  };

  return {
    scanToInsertionPoint(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        if (state === "data") return i;
        step(chunk[i]!);
      }
      return chunk.length;
    },
    write(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        step(chunk[i]!);
      }
    },
    isSafe() {
      return state === "data";
    },
  };
}
