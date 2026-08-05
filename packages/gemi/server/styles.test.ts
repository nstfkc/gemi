/** @vitest-environment node */
import { createElement, Fragment } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { createStyles } from "./styles";

const Root = () =>
  createElement(
    "html",
    null,
    createElement("head", null, createElement("title", null, "t")),
    createElement("body", null, createElement("div", { id: "root" }, "hello")),
  );

/**
 * The real render root: styles are spread as siblings *before* the component
 * that renders `<html>`. That placement is the whole reason hoisting matters —
 * a style React declines to hoist ends up in `<body>`, where it blocks
 * nothing.
 */
async function renderDocument(styles: Awaited<ReturnType<typeof createStyles>>) {
  const stream = await renderToReadableStream(
    createElement(Fragment, {
      children: [...styles, createElement(Root, { key: "root" })],
    }),
  );
  await stream.allReady;
  return await new Response(stream).text();
}

describe("createStyles", () => {
  test("hoists stylesheets into <head> so the first paint is blocked on them", async () => {
    const html = await renderDocument(
      await createStyles([{ id: "assets/app.css", content: ".app{color:red}" }]),
    );

    const [head, body] = html.split("<body>");
    expect(head).toContain(".app{color:red}");
    expect(body).not.toContain(".app{color:red}");
  });

  test("keeps stylesheets in the order they were passed", async () => {
    const html = await renderDocument(
      await createStyles([
        { id: "assets/app.css", content: ".app{color:red}" },
        { id: "assets/view.css", content: ".view{color:blue}" },
      ]),
    );

    expect(html.indexOf(".app{color:red}")).toBeLessThan(html.indexOf(".view{color:blue}"));
  });

  /**
   * React drops the `id` off anything it hoists and records the merged files in
   * `data-href` instead — which is the only handle `fetchRouteCSS` has for
   * telling whether a route's CSS is already on the page.
   */
  test("records every file it merged in data-href", async () => {
    const html = await renderDocument(
      await createStyles([
        { id: "assets/app.css", content: ".app{color:red}" },
        { id: "assets/view.css", content: ".view{color:blue}" },
      ]),
    );

    const dataHref = html.match(/data-href="([^"]*)"/)?.[1];
    expect(dataHref?.split(" ")).toEqual(["assets/app.css", "assets/view.css"]);
  });
});
