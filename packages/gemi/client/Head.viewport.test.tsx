/** @vitest-environment jsdom */
import { expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Head } from "./Head";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";

/** `<Head viewport themeColor>`: a layout sets the viewport keys and the theme colours (#1172). */

function render(props: Parameters<typeof Head>[0] = {}) {
  const html = renderToString(
    <ServerDataContext.Provider value={{ meta: {} } as unknown as ServerDataContextValue}>
      <Head {...props} />
    </ServerDataContext.Provider>,
  );
  const container = document.createElement("div");
  container.innerHTML = html.replace(/^<head>|<\/head>$/g, "");
  return { html, container };
}

const viewports = (container: HTMLElement) =>
  [...container.querySelectorAll('meta[name="viewport"]')].map((meta) => meta.getAttribute("content"));

test("renders the default viewport and no theme-color without props", () => {
  const { html, container } = render();
  expect(viewports(container)).toEqual(["width=device-width, initial-scale=1"]);
  expect(html).not.toContain("theme-color");
});

test("adds viewport-fit and interactive-widget to the one viewport meta", () => {
  const { container } = render({ viewport: { fit: "cover", interactiveWidget: "resizes-content" } });
  expect(viewports(container)).toEqual([
    "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
  ]);
});

test("never limits zoom", () => {
  const { container } = render({ viewport: { fit: "cover" } });
  const [content] = viewports(container);
  expect(content).not.toMatch(/maximum-scale|user-scalable/);
});

test("a single theme colour renders one tag without media", () => {
  const { container } = render({ themeColor: "#ffffff" });
  const tags = [...container.querySelectorAll('meta[name="theme-color"]')];
  expect(tags).toHaveLength(1);
  expect(tags[0].getAttribute("content")).toBe("#ffffff");
  expect(tags[0].hasAttribute("media")).toBe(false);
});

test("one theme-color per colour scheme", () => {
  const { container } = render({
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: "#ffffff" },
      { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    ],
  });
  const tags = [...container.querySelectorAll('meta[name="theme-color"]')].map((meta) => [
    meta.getAttribute("media"),
    meta.getAttribute("content"),
  ]);
  expect(tags).toEqual([
    ["(prefers-color-scheme: light)", "#ffffff"],
    ["(prefers-color-scheme: dark)", "#0a0a0a"],
  ]);
});
