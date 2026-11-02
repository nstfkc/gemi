/** @vitest-environment jsdom */
import { afterEach, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Metadata } from "../http/Metadata";
import { Head, updateMeta } from "./Head";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";

/** `Meta.tags` and `Meta.alternates` with a `type` and no `hreflang` (#1115). */

afterEach(() => {
  document.head.innerHTML = "";
});

function render(metadata: Metadata) {
  return renderToString(
    <ServerDataContext.Provider value={{ meta: metadata.render() } as unknown as ServerDataContextValue}>
      <Head />
    </ServerDataContext.Provider>,
  );
}

test("<Head /> renders the tags a handler added, marked for replacement", () => {
  const metadata = new Metadata();
  metadata.tags([{ name: "google-site-verification", content: "abc" }]);
  metadata.tags([{ property: "fb:app_id", content: "123" }]);
  expect(metadata.touched).toBe(true);
  const html = render(metadata);
  expect(html).toContain('<meta name="google-site-verification" content="abc" data-gemi-meta=""/>');
  expect(html).toContain('<meta property="fb:app_id" content="123" data-gemi-meta=""/>');
});

test("calls add up", () => {
  const metadata = new Metadata();
  metadata.tags([{ name: "a", content: "1" }]);
  metadata.tags([{ name: "b", content: "2" }]);
  expect(metadata.render().tags).toEqual([
    { name: "a", content: "1" },
    { name: "b", content: "2" },
  ]);
});

test("no tags unless some are added", () => {
  const metadata = new Metadata();
  expect(metadata.render().tags).toBeNull();
  expect(render(metadata)).not.toContain("data-gemi-meta");
});

test("a tag needs exactly one of name and property, and a string content", () => {
  const metadata = new Metadata();
  expect(() => metadata.tags([{ content: "x" } as never])).toThrow(TypeError);
  expect(() => metadata.tags([{ name: "", content: "x" }])).toThrow(TypeError);
  expect(() => metadata.tags([{ name: "a", property: "b", content: "x" } as never])).toThrow(TypeError);
  expect(() => metadata.tags([{ name: "a", content: undefined } as never])).toThrow(TypeError);
  expect(metadata.touched).toBe(false);
});

test("names and contents are escaped", () => {
  const metadata = new Metadata();
  metadata.tags([{ name: 'a"><script>', content: 'b"><script>' }]);
  const html = render(metadata);
  expect(html).not.toContain("<script>");
  expect(html).toContain('name="a&quot;&gt;&lt;script&gt;" content="b&quot;&gt;&lt;script&gt;"');
});

test("a navigation replaces the tags, and drops them for a page that adds none", () => {
  updateMeta({ title: "A", tags: [{ name: "google-site-verification", content: "abc" }] });
  expect(document.head.querySelector('meta[name="google-site-verification"]')!.getAttribute("content")).toBe("abc");

  updateMeta({ title: "B", tags: [{ property: "fb:app_id", content: "123" }] });
  expect(document.head.querySelector('meta[name="google-site-verification"]')).toBeNull();
  expect(document.head.querySelectorAll("meta[data-gemi-meta]")).toHaveLength(1);
  expect(document.head.querySelector('meta[property="fb:app_id"]')!.getAttribute("content")).toBe("123");

  updateMeta({ title: "C" });
  expect(document.head.querySelector("meta[data-gemi-meta]")).toBeNull();
});

test("a layout's own tag with the same name is left alone", () => {
  const own = document.createElement("meta");
  own.setAttribute("name", "google-site-verification");
  own.setAttribute("content", "layout");
  document.head.appendChild(own);

  updateMeta({ title: "A", tags: [{ name: "google-site-verification", content: "page" }] });
  updateMeta({ title: "B" });

  expect([...document.head.querySelectorAll('meta[name="google-site-verification"]')]).toEqual([own]);
});

test("a partially rendered response without metadata keeps the tags", () => {
  updateMeta({ title: "A", tags: [{ name: "a", content: "1" }] });
  updateMeta(null);
  expect(document.head.querySelector('meta[name="a"]')!.getAttribute("content")).toBe("1");
});

test("<Head /> renders an alternate with a type and no hreflang", () => {
  const metadata = new Metadata();
  metadata.alternates([
    { hrefLang: "tr", href: "https://example.com/tr" },
    { type: "text/markdown", href: "https://example.com/page.md" },
  ]);
  const html = render(metadata);
  expect(html).toContain('<link rel="alternate" href="https://example.com/tr" hrefLang="tr" data-gemi-meta=""/>');
  expect(html).toContain(
    '<link rel="alternate" href="https://example.com/page.md" type="text/markdown" data-gemi-meta=""/>',
  );
});

test("a navigation replaces a typed alternate like the others", () => {
  updateMeta({ title: "A", alternates: [{ type: "text/markdown", href: "/a.md" }] });
  const link = document.head.querySelector('link[rel="alternate"]')!;
  expect(link.getAttribute("type")).toBe("text/markdown");
  expect(link.getAttribute("href")).toBe("/a.md");
  expect(link.hasAttribute("hreflang")).toBe(false);

  updateMeta({ title: "B", alternates: [{ hrefLang: "tr", href: "/tr/b" }] });
  const links = document.head.querySelectorAll('link[rel="alternate"]');
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("hreflang")).toBe("tr");
  expect(links[0].hasAttribute("type")).toBe(false);

  updateMeta({ title: "C" });
  expect(document.head.querySelector('link[rel="alternate"]')).toBeNull();
});
