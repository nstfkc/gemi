/** @vitest-environment jsdom */
import { afterEach, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Metadata } from "../http/Metadata";
import { Head, updateMeta } from "./Head";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";

/** `Meta.translate`: a page may leave out `<meta name="google" content="notranslate">` (#1087). */

const NOTRANSLATE = '<meta name="google" content="notranslate"/>';
const selector = 'meta[name="google"][content="notranslate"]';

afterEach(() => {
  document.head.innerHTML = "";
  // Reset the module's "gemi removed the tag" latch for the next test.
  updateMeta({ title: "reset" });
  document.head.innerHTML = "";
});

function render(metadata: Metadata) {
  return renderToString(
    <ServerDataContext.Provider value={{ meta: metadata.render() } as unknown as ServerDataContextValue}>
      <Head />
    </ServerDataContext.Provider>,
  );
}

function headWithNotranslate() {
  const element = document.createElement("meta");
  element.setAttribute("name", "google");
  element.setAttribute("content", "notranslate");
  document.head.appendChild(element);
  return element;
}

test("<Head /> renders the notranslate tag by default", () => {
  const metadata = new Metadata();
  expect(metadata.render().translate).toBeNull();
  expect(render(metadata)).toContain(NOTRANSLATE);
});

test("Meta.translate() leaves it out", () => {
  const metadata = new Metadata();
  metadata.translate();
  expect(metadata.touched).toBe(true);
  expect(metadata.render().translate).toBe(true);
  expect(render(metadata)).not.toContain("notranslate");
});

test("Meta.translate(false) keeps it, and the last call wins", () => {
  const metadata = new Metadata();
  metadata.translate();
  metadata.translate(false);
  expect(render(metadata)).toContain(NOTRANSLATE);
});

test("the views' default applies unless a handler called translate", () => {
  const untouched = new Metadata();
  untouched.applyTranslateDefault(true);
  expect(untouched.touched).toBe(false);
  expect(render(untouched)).not.toContain("notranslate");

  const handler = new Metadata();
  handler.translate(false);
  handler.applyTranslateDefault(true);
  expect(render(handler)).toContain(NOTRANSLATE);
});

test("a navigation drops the tag for a page that allows translation, and puts it back after", () => {
  headWithNotranslate();

  updateMeta({ title: "A", translate: true });
  expect(document.head.querySelector(selector)).toBeNull();

  updateMeta({ title: "B", translate: true });
  expect(document.head.querySelector(selector)).toBeNull();

  updateMeta({ title: "C" });
  expect(document.head.querySelectorAll(selector)).toHaveLength(1);

  updateMeta({ title: "D", translate: false });
  expect(document.head.querySelectorAll(selector)).toHaveLength(1);
});

test("a page that keeps the tag leaves the layout's alone", () => {
  const own = headWithNotranslate();
  updateMeta({ title: "A" });
  updateMeta({ title: "B" });
  expect([...document.head.querySelectorAll(selector)]).toEqual([own]);
});

test("a partially rendered response without metadata keeps the current state", () => {
  headWithNotranslate();
  updateMeta({ title: "A", translate: true });
  updateMeta(null);
  expect(document.head.querySelector(selector)).toBeNull();
});
