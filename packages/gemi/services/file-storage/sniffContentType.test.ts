import { describe, expect, test } from "vitest";

import {
  extensionFor,
  isActiveContentType,
  isAllowedContentType,
  sniffContentType,
} from "./sniffContentType";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const withAscii = (prefix: number[], ascii: string, suffix: number[] = []) =>
  new Uint8Array([...prefix, ...text(ascii), ...suffix]);

describe("sniffContentType", () => {
  test.each<[string, Uint8Array, string]>([
    ["PNG", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0), "image/png"],
    ["JPEG", bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10), "image/jpeg"],
    ["GIF", text("GIF89a\x01\x00"), "image/gif"],
    ["WebP", text("RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp"],
    ["WAV", text("RIFF\x00\x00\x00\x00WAVEfmt "), "audio/wav"],
    ["AVIF", withAscii([0, 0, 0, 0x1c], "ftypavif"), "image/avif"],
    ["HEIC", withAscii([0, 0, 0, 0x18], "ftypheic"), "image/heic"],
    ["MP4", withAscii([0, 0, 0, 0x20], "ftypisom"), "video/mp4"],
    ["QuickTime", withAscii([0, 0, 0, 0x14], "ftypqt  "), "video/quicktime"],
    ["TIFF", bytes(0x49, 0x49, 0x2a, 0x00, 8, 0), "image/tiff"],
    ["BMP", bytes(0x42, 0x4d, 1, 2, 3, 4, 0, 0, 0, 0, 0x36), "image/bmp"],
    ["ICO", bytes(0, 0, 1, 0, 1, 0, 16), "image/x-icon"],
    ["PDF", text("%PDF-1.7\n"), "application/pdf"],
    ["ZIP", bytes(0x50, 0x4b, 0x03, 0x04, 20, 0), "application/zip"],
    ["gzip", bytes(0x1f, 0x8b, 8, 0), "application/gzip"],
    ["WebM", withAscii([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], "webm"), "video/webm"],
    ["Ogg", text("OggS\x00\x02"), "audio/ogg"],
    ["FLAC", text("fLaC\x00"), "audio/flac"],
    ["MP3 with ID3", text("ID3\x04\x00"), "audio/mpeg"],
    ["MP3 frame", bytes(0xff, 0xfb, 0x90, 0x64), "audio/mpeg"],
    ["AAC", bytes(0xff, 0xf1, 0x50, 0x80), "audio/aac"],
    ["WOFF2", text("wOF2\x00\x01"), "font/woff2"],
    ["TTF", bytes(0, 1, 0, 0, 0, 0x10), "font/ttf"],
  ])("%s", (_, input, expected) => {
    expect(sniffContentType(input)).toBe(expected);
  });

  test("SVG, after a BOM, an XML declaration, a comment and a doctype", () => {
    const svg =
      '﻿  <?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(sniffContentType(text(svg))).toBe("image/svg+xml");
    expect(sniffContentType(text("<svg/>"))).toBe("image/svg+xml");
  });

  test("HTML", () => {
    expect(sniffContentType(text("<!DOCTYPE html><html>"))).toBe("text/html");
    expect(sniffContentType(text("\n  <HTML lang=en>"))).toBe("text/html");
    expect(sniffContentType(text("<script>alert(1)</script>"))).toBe("text/html");
    expect(sniffContentType(text("<!-- x --><p>hi"))).toBe("text/html");
    // Starts like a tag in the list, but is a different tag.
    expect(sniffContentType(text("<abbr>x</abbr>"))).toBe("text/plain");
  });

  test("XML that is not SVG", () => {
    expect(sniffContentType(text('<?xml version="1.0"?><feed/>'))).toBe("application/xml");
  });

  test("text, and the binary that is not", () => {
    expect(sniffContentType(text('{"a": 1}\n'))).toBe("text/plain");
    expect(sniffContentType(text("name,age\nÅsa,3\n"))).toBe("text/plain");
    // A multi-byte character cut off at the end of the window.
    expect(sniffContentType(text("héllo").subarray(0, 2))).toBe("text/plain");
    expect(sniffContentType(bytes(0x00, 0x13, 0x37))).toBe("application/octet-stream");
    expect(sniffContentType(bytes(0xc3, 0x28))).toBe("application/octet-stream");
    expect(sniffContentType(new Uint8Array())).toBe("application/octet-stream");
  });

  test("extensionFor", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("application/octet-stream")).toBe("bin");
    expect(extensionFor("something/else")).toBe("bin");
  });
});

describe("isAllowedContentType", () => {
  test("exact types and wildcards", () => {
    expect(isAllowedContentType("image/png", ["image/*"])).toBe(true);
    expect(isAllowedContentType("image/png", ["IMAGE/PNG"])).toBe(true);
    expect(isAllowedContentType("application/pdf", ["image/*"])).toBe(false);
    expect(isAllowedContentType("application/pdf", ["image/*", "application/pdf"])).toBe(true);
    expect(isAllowedContentType("video/mp4", ["*/*"])).toBe(true);
  });

  test("a wildcard never covers types that can carry script", () => {
    expect(isAllowedContentType("image/svg+xml", ["image/*"])).toBe(false);
    expect(isAllowedContentType("text/html", ["text/*"])).toBe(false);
    expect(isAllowedContentType("text/html", ["*/*"])).toBe(false);
    expect(isAllowedContentType("image/svg+xml", ["image/*", "image/svg+xml"])).toBe(true);
    expect(isAllowedContentType("text/xml", ["text/*"])).toBe(false);
    expect(isAllowedContentType("application/xml", ["application/*"])).toBe(false);
    expect(isAllowedContentType("application/atom+xml", ["*/*"])).toBe(false);
    expect(isAllowedContentType("application/xml", ["application/xml"])).toBe(true);
  });
});

describe("isActiveContentType", () => {
  test("HTML, SVG and XML in all their variants", () => {
    for (const type of [
      "text/html",
      "TEXT/HTML; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "application/rss+xml",
      "text/xsl",
    ]) {
      expect(isActiveContentType(type)).toBe(true);
    }
  });

  test("everything else", () => {
    for (const type of ["image/png", "text/plain", "application/json", "application/pdf", "application/octet-stream"]) {
      expect(isActiveContentType(type)).toBe(false);
    }
  });
});
