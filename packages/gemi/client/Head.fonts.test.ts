/** @vitest-environment jsdom */
import { afterEach, expect, test } from "vitest";
import { normalizeFonts } from "./fonts";
import { updateMeta } from "./Head";

/** `Meta.fonts` on a client-side navigation (#849). */

const fontStyles = () =>
  [...document.head.querySelectorAll("style[data-gemi-fonts]")].map((style) => style.textContent);

afterEach(() => {
  document.head.innerHTML = "";
});

test("a navigation adds the new page's @font-face rules once and removes none", () => {
  const acme = { family: "Acme", src: "/acme.woff2", preload: true };
  const serif = { family: "Serif", src: "/serif.woff2" };

  updateMeta({ fonts: normalizeFonts([acme]) });
  updateMeta({ fonts: normalizeFonts([acme, serif]) });
  updateMeta({ fonts: null });
  updateMeta({ fonts: normalizeFonts([serif]) });

  expect(fontStyles()).toEqual([
    '@font-face { font-family: "Acme"; src: url("/acme.woff2") format("woff2"); font-display: swap; }',
    '@font-face { font-family: "Serif"; src: url("/serif.woff2") format("woff2"); font-display: swap; }',
  ]);
  // Preloading after the page has rendered is too late to help: no preloads.
  expect(document.head.querySelector('link[rel="preload"]')).toBeNull();
});
