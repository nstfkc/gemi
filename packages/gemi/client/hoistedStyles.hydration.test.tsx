/** @vitest-environment jsdom */
import { createElement, Fragment } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createStyles } from "../server/styles";

const APP_CSS = ".app{color:red}";

/**
 * What `init` hydrates the document with: two empty slots standing in for the
 * server-only siblings (the stylesheets and the theme script) and then the
 * app. The stylesheets have no client counterpart at all — the point of this
 * test is that hoisting them into `<head>` keeps it that way.
 */
const Root = () =>
  createElement(
    "html",
    null,
    createElement("head", null, createElement("title", null, "t")),
    createElement("body", null, createElement("div", { id: "root" }, "hello")),
  );

async function serverHTML() {
  const stream = await renderToReadableStream(
    createElement(Fragment, {
      children: [
        ...(await createStyles([{ id: "assets/app.css", content: APP_CSS }])),
        createElement("script", {
          key: "theme-script",
          dangerouslySetInnerHTML: { __html: "0" },
        }),
        createElement(Root, { key: "root" }),
      ],
    }),
  );
  await stream.allReady;
  return await new Response(stream).text();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hoisted stylesheets", () => {
  test("survive hydration of the document", async () => {
    const html = await serverHTML();
    // jsdom will not let the doctype be assigned through innerHTML.
    document.documentElement.innerHTML = html
      .replace("<!DOCTYPE html>", "")
      .replace(/^<html>/, "")
      .replace(/<\/html>$/, "");

    expect(document.head.textContent).toContain(APP_CSS);

    const recoverable = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      hydrateRoot(
        document,
        createElement(Fragment, {
          children: [
            createElement(Fragment, { key: "styles" }),
            createElement(Fragment, { key: "theme" }),
            createElement(Root, { key: "root" }),
          ],
        }),
        { onRecoverableError: recoverable },
      );
    });

    expect(recoverable).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    // The client never renders the stylesheet, so nothing must evict it.
    expect(document.head.textContent).toContain(APP_CSS);
    expect(document.getElementById("root")?.textContent).toBe("hello");
  });
});
