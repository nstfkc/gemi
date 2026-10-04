import { describe, expect, test } from "vitest";

import { spliceIslandSlots } from "./staticDocument";

const slot = (uid: string) => `<gemi-slot data-slot="${uid}" style="display:contents"></gemi-slot>`;
const filled = (content: string) => `<gemi-slot style="display:contents">${content}</gemi-slot>`;
const template = (uid: string, content: string) => `<template data-gemi-slot="${uid}">${content}</template>`;
const island = (uid: string, inner: string) => `<gemi-island data-uid="${uid}">${inner}</gemi-island>`;

describe("spliceIslandSlots", () => {
  test("moves an island's children from its template into its slot", () => {
    const html = `<main>${island("i0-", `<nav>${slot("i0-")}</nav>`)}${template("i0-", "<a>x</a>")}</main>`;

    expect(spliceIslandSlots(html)).toBe(`<main>${island("i0-", `<nav>${filled("<a>x</a>")}</nav>`)}</main>`);
  });

  test("handles an island in another island's children, and the app's own templates", () => {
    const inner = `${island("i1-", `<b>${slot("i1-")}</b>`)}${template("i1-", "<i>deep</i><template><p>app</p></template>")}`;
    const html = `${island("i0-", `<div>${slot("i0-")}</div>`)}${template("i0-", `<p>child</p>${inner}`)}<template id="t">keep</template>`;

    expect(spliceIslandSlots(html)).toBe(
      `${island("i0-", `<div>${filled(`<p>child</p>${island("i1-", `<b>${filled("<i>deep</i><template><p>app</p></template>")}</b>`)}`)}</div>`)}` +
        `<template id="t">keep</template>`,
    );
  });

  test("drops children the island did not render", () => {
    expect(spliceIslandSlots(`${island("i0-", "<p>no slot</p>")}${template("i0-", "<a>x</a>")}`)).toBe(
      island("i0-", "<p>no slot</p>"),
    );
  });

  test("leaves a document without islands alone", () => {
    const html = "<html><body><template><p>x</p></template></body></html>";
    expect(spliceIslandSlots(html)).toBe(html);
  });
});
