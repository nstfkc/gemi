/**
 * The media type of a file, read from its first bytes rather than from a name
 * or a `Content-Type` header someone else chose.
 *
 * Recognizes the common image, audio, video, font, document and archive
 * formats by their signatures, SVG, HTML and XML by their markup, and
 * otherwise answers `text/plain` for bytes that decode as UTF-8 text with no
 * control characters, and `application/octet-stream` for anything else.
 * Formats that are text underneath (JSON, CSV, JavaScript, CSS) can't be told
 * apart from their bytes and come out as `text/plain`.
 *
 * A few kilobytes are enough: `SNIFF_BYTES` is what `Storage.putFromUrl()`
 * reads before deciding.
 */
export function sniffContentType(bytes: Uint8Array): string {
  return binaryType(bytes) ?? markupType(bytes) ?? textOrBinary(bytes);
}

/** How many leading bytes `sniffContentType` looks at, at most. */
export const SNIFF_BYTES = 4096;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/xml": "xml",
  "text/html": "html",
  "text/plain": "txt",
  "application/octet-stream": "bin",
};

/** The file extension `putFromUrl` names an object of this type with. */
export function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType] ?? "bin";
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

const FTYP_BRANDS: Record<string, string> = {
  avif: "image/avif",
  avis: "image/avif",
  heic: "image/heic",
  heix: "image/heic",
  hevc: "image/heic",
  hevx: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
  "qt  ": "video/quicktime",
  "M4A ": "audio/mp4",
  "M4B ": "audio/mp4",
};

function binaryType(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
    return "image/gif";
  }
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF") {
    const kind = ascii(b, 8, 12);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
    if (kind === "AVI ") return "video/x-msvideo";
  }
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    return FTYP_BRANDS[brand] ?? "video/mp4";
  }
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image/tiff";
  }
  // "BM", then four bytes of file size and four reserved zero bytes.
  if (startsWith(b, [0x42, 0x4d]) && startsWith(b, [0, 0, 0, 0], 6)) return "image/bmp";
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00]) && b.length >= 6 && b[4]! > 0) {
    return "image/x-icon";
  }
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith(b, [0x1f, 0x8b])) return "application/gzip";
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(b, 0, Math.min(b.length, 64)).includes("webm")
      ? "video/webm"
      : "video/x-matroska";
  }
  if (b.length >= 4) {
    const magic = ascii(b, 0, 4);
    if (magic === "OggS") return "audio/ogg";
    if (magic === "fLaC") return "audio/flac";
    if (magic === "wOFF") return "font/woff";
    if (magic === "wOF2") return "font/woff2";
    if (magic === "OTTO") return "font/otf";
  }
  if (startsWith(b, [0x00, 0x01, 0x00, 0x00, 0x00])) return "font/ttf";
  if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff) {
    // MPEG audio frame sync: 11 set bits. Layer bits 00 are ADTS (AAC).
    if ((b[1]! & 0xf6) === 0xf0) return "audio/aac";
    if ((b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return "audio/mpeg";
  }
  return null;
}

// The tags the WHATWG MIME sniffing standard treats as an HTML document.
const HTML_TAGS = [
  "!doctype html",
  "html",
  "head",
  "script",
  "iframe",
  "h1",
  "div",
  "font",
  "table",
  "a",
  "style",
  "title",
  "b",
  "body",
  "br",
  "p",
  "!--",
];

function markupType(b: Uint8Array): string | null {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(b);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.trimStart();
  if (!text.startsWith("<")) return null;
  const lower = text.toLowerCase();

  // An SVG may open with an XML declaration, comments, processing
  // instructions and a doctype before its root element.
  let rest = lower;
  for (;;) {
    rest = rest.trimStart();
    const skip = /^(<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)/.exec(rest);
    if (!skip) break;
    rest = rest.slice(skip[0].length);
  }
  if (/^<svg[\s>/]/.test(rest)) return "image/svg+xml";

  for (const tag of HTML_TAGS) {
    if (!lower.startsWith(`<${tag}`)) continue;
    // The tag has to end there: `<a` is HTML, `<abc` is not.
    if (/^[\s>]/.test(lower.charAt(tag.length + 1))) return "text/html";
  }
  // Markup after a leading comment or doctype is HTML too, once one of the
  // tags above follows.
  if (/^<(html|head|body)[\s>]/.test(rest)) return "text/html";
  if (lower.startsWith("<?xml")) return "application/xml";
  return null;
}

function textOrBinary(b: Uint8Array): string {
  if (b.length === 0) return "application/octet-stream";
  for (const byte of b) {
    // Control characters other than tab, newline, form feed, carriage return
    // and escape mean binary.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b) {
      return "application/octet-stream";
    }
  }
  try {
    // `stream: true` lets a multi-byte character cut off at the end of the
    // window through.
    new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: true });
    return "text/plain";
  } catch {
    return "application/octet-stream";
  }
}

// Types a browser treats as active content: HTML, SVG and XML can carry
// script. A wildcard such as `image/*`, `text/*` or `*/*` never lets them
// through, and `putFromUrl` without `contentTypes` refuses them; they have to
// be listed by name.
const ACTIVE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/xsl",
  "application/xslt+xml",
]);

/**
 * Whether a media type is active content a browser may run script from:
 * HTML, XHTML, SVG and XML, including any `+xml` type (`image/svg+xml`,
 * `application/atom+xml`, ...).
 */
export function isActiveContentType(type: string): boolean {
  const essence = type.split(";")[0]!.trim().toLowerCase();
  return ACTIVE_TYPES.has(essence) || essence.endsWith("+xml");
}

/**
 * Whether a sniffed type is in an allow-list of media types such as
 * `["image/*", "application/pdf"]`. A wildcard never covers HTML, SVG or XML
 * (see `isActiveContentType`), which can carry script; name them explicitly
 * to accept them.
 */
export function isAllowedContentType(type: string, allowed: readonly string[]): boolean {
  const essence = type.split(";")[0]!.trim().toLowerCase();
  return allowed.some((entry) => {
    const pattern = entry.split(";")[0]!.trim().toLowerCase();
    if (pattern === "*/*" || pattern === "*") return !isActiveContentType(essence);
    if (pattern.endsWith("/*")) {
      return essence.startsWith(pattern.slice(0, -1)) && !isActiveContentType(essence);
    }
    return essence === pattern;
  });
}
