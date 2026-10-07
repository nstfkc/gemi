/**
 * The little XML a sitemap needs, both ways: escaping for the writer, and a
 * forgiving scanner for the reader.
 *
 * The scanner is not a general XML parser and doesn't try to be. It walks tags
 * with `indexOf` (no backtracking regexes over the document), never expands an
 * entity a DOCTYPE declares (only the five predefined ones and character
 * references), and doesn't resolve namespaces: elements are matched by local
 * name, so `<ns:url>` is a `url`.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(value: string) {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g,
    (match, ref: string) => {
      if (ref[0] !== "#") return NAMED[ref] ?? match;
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}

export type XmlHandlers = {
  open(name: string, attributes: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  text(value: string): void;
  /** Returning `true` stops the scan. */
  stopped?(): boolean;
};

/** The part after the prefix, lower-cased: `xhtml:Link` is `link`. */
function localName(name: string) {
  const colon = name.indexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

export function scanXml(source: string, handlers: XmlHandlers) {
  const length = source.length;
  let index = 0;
  while (index < length) {
    if (handlers.stopped?.()) return;
    const lt = source.indexOf("<", index);
    if (lt === -1) {
      handlers.text(decodeEntities(source.slice(index)));
      return;
    }
    if (lt > index) handlers.text(decodeEntities(source.slice(index, lt)));

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) return;
      index = end + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end === -1) return;
      handlers.text(source.slice(lt + 9, end));
      index = end + 3;
    } else if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end === -1) return;
      index = end + 2;
    } else if (source.startsWith("<!", lt)) {
      // A DOCTYPE, possibly with an internal subset in brackets. Skipped whole;
      // what it declares is never used.
      const close = source.indexOf(">", lt + 2);
      if (close === -1) return;
      const bracket = source.indexOf("[", lt + 2);
      if (bracket !== -1 && bracket < close) {
        const subsetEnd = source.indexOf("]", bracket + 1);
        if (subsetEnd === -1) return;
        const end = source.indexOf(">", subsetEnd + 1);
        if (end === -1) return;
        index = end + 1;
      } else {
        index = close + 1;
      }
    } else if (source[lt + 1] === "/") {
      const end = source.indexOf(">", lt + 2);
      if (end === -1) return;
      handlers.close(localName(source.slice(lt + 2, end).trim()));
      index = end + 1;
    } else {
      const end = tagEnd(source, lt + 1);
      if (end === -1) return;
      let body = source.slice(lt + 1, end);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const nameEnd = body.search(/[\s]|$/);
      const name = localName(body.slice(0, nameEnd));
      if (name) {
        handlers.open(name, parseAttributes(body.slice(nameEnd)), selfClosing);
        if (selfClosing) handlers.close(name);
      }
      index = end + 1;
    }
  }
}

/** The `>` that ends a start tag, skipping any inside quoted attribute values. */
function tagEnd(source: string, from: number) {
  let quote: string | null = null;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

function parseAttributes(text: string) {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of text.matchAll(pattern)) {
    attributes[localName(match[1])] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}
