/** @vitest-environment jsdom */
import { afterEach, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Metadata } from "../http/Metadata";
import { Head, updateMeta } from "./Head";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";

/** `Meta.robots`: a per-response `<meta name="robots">` (#972). */

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

test("<Head /> renders the robots tag a handler set", () => {
  const metadata = new Metadata();
  metadata.robots("noindex, nofollow");
  expect(metadata.touched).toBe(true);
  expect(render(metadata)).toContain('<meta name="robots" content="noindex, nofollow" data-gemi-meta=""/>');
});

test("the last call wins", () => {
  const metadata = new Metadata();
  metadata.robots("noindex");
  metadata.robots("noindex, nofollow");
  expect(metadata.render().robots).toBe("noindex, nofollow");
});

test("no robots tag unless one is set", () => {
  const metadata = new Metadata();
  expect(metadata.render().robots).toBeNull();
  expect(render(metadata)).not.toContain('name="robots"');
});

test("the content is escaped", () => {
  const metadata = new Metadata();
  metadata.robots('noindex"><script>');
  expect(render(metadata)).toContain('content="noindex&quot;&gt;&lt;script&gt;"');
});

test("a navigation replaces the robots tag, and drops it for a page that sets none", () => {
  updateMeta({ title: "A", robots: "noindex, nofollow" });
  expect(document.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
  expect(document.head.querySelector('meta[name="robots"]')!.getAttribute("content")).toBe("noindex, nofollow");

  updateMeta({ title: "B", robots: "noindex" });
  expect(document.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
  expect(document.head.querySelector('meta[name="robots"]')!.getAttribute("content")).toBe("noindex");

  updateMeta({ title: "C" });
  expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
});

test("a layout's own robots tag is left alone", () => {
  const own = document.createElement("meta");
  own.setAttribute("name", "robots");
  own.setAttribute("content", "noarchive");
  document.head.appendChild(own);

  updateMeta({ title: "A", robots: "noindex" });
  updateMeta({ title: "B" });

  expect([...document.head.querySelectorAll('meta[name="robots"]')]).toEqual([own]);
});

test("a partially rendered response without metadata keeps the tag", () => {
  updateMeta({ title: "A", robots: "noindex" });
  updateMeta(null);
  expect(document.head.querySelector('meta[name="robots"]')!.getAttribute("content")).toBe("noindex");
});
