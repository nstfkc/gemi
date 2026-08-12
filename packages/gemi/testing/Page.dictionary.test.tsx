/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { defineDictionary } from "../i18n/defineDictionary";
import { __resetDictionaryRegistry } from "../i18n/dictionaryRegistry";
import { useDictionary } from "../client/useDictionary";
import { useLocale } from "../client/useLocale";
import { useTranslator } from "../client/useTranslator";
import { Page } from "./Page";

/**
 * `<Page>` against the `defineDictionary` API.
 *
 * The seeding story inverts here, and that is the point worth pinning down. A
 * `useTranslator` component needs its strings handed to `<Page>` — through
 * `dictionaries` or `translations` — because the browser only ever sees what
 * the server serialized for it. A `useDictionary` component carries its own:
 * the dictionary is a module the component imports, and unbundled it holds
 * every locale and resolves synchronously. So a test seeds `locale` and nothing
 * else, and there is no name string that can drift out of sync with the page.
 */

const greeting = defineDictionary({
  greeting: { "en-US": "Hello {{name}}", "tr-TR": "Merhaba {{name}}" },
  cta: { "en-US": "Get started", "tr-TR": "Başla" },
});

function Greeter() {
  const t = useDictionary(greeting);
  return (
    <div>
      <h1>{t("greeting", { name: "Enes" })}</h1>
      <button type="button">{t("cta")}</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  __resetDictionaryRegistry();
});

describe("a useDictionary component under <Page>", () => {
  test("renders without any dictionary seeding at all", () => {
    render(
      <Page>
        <Greeter />
      </Page>,
    );

    // No `dictionaries`, no `translations` — the component brought its own.
    expect(screen.getByRole("heading").textContent).toBe("Hello Enes");
    expect(screen.getByRole("button").textContent).toBe("Get started");
  });

  test("follows the page's locale", () => {
    // `<Page>` seeds `i18n.currentLocale`, which is the same input
    // `useDictionary` reads at runtime — so locale-dependent rendering is
    // testable without touching the dictionary.
    render(
      <Page locale="tr-TR">
        <Greeter />
      </Page>,
    );

    expect(screen.getByRole("heading").textContent).toBe("Merhaba Enes");
    expect(screen.getByRole("button").textContent).toBe("Başla");
  });

  test("reports that locale through useLocale as well", () => {
    const Probe = () => <span data-testid="locale">{useLocale()[0]}</span>;
    render(
      <Page locale="tr-TR">
        <Probe />
      </Page>,
    );
    expect(screen.getByTestId("locale").textContent).toBe("tr-TR");
  });

  test("falls back to the source language for a locale it has no strings for", () => {
    // An app whose supported locales outrun a given dictionary should render
    // that dictionary in its source language rather than as raw keys.
    render(
      <Page locale="de-DE" supportedLocales={["en-US", "de-DE"]}>
        <Greeter />
      </Page>,
    );
    expect(screen.getByRole("heading").textContent).toBe("Hello Enes");
  });

  test("composes with a useTranslator component on the same page", () => {
    // Both APIs are supported at once, so a half-migrated app has to render.
    const legacy = {
      name: "Legacy",
      dictionary: { title: { "en-US": "Legacy title", "tr-TR": "Eski başlık" } },
    };
    const Legacy = () => (
      <p data-testid="legacy">
        {useTranslator("Legacy" as never)("title" as never)}
      </p>
    );

    render(
      <Page locale="tr-TR" dictionaries={[legacy]}>
        <Greeter />
        <Legacy />
      </Page>,
    );

    expect(screen.getByRole("heading").textContent).toBe("Merhaba Enes");
    expect(screen.getByTestId("legacy").textContent).toBe("Eski başlık");
  });
});
