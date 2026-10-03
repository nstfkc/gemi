/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";

import { defineDictionary } from "../i18n/defineDictionary";
import { __resetDictionaryRegistry } from "../i18n/dictionaryRegistry";
import { Page } from "../testing/Page";
import { useDictionary } from "./useDictionary";
import { useFormatter } from "./useFormatter";

/** Still the 1st in UTC, already the 2nd in Istanbul. */
const lateEvening = Date.UTC(2026, 10, 1, 22, 30);

function When(props: { timeZone?: string }) {
  const format = useFormatter(props.timeZone ? { timeZone: props.timeZone } : {});
  return <time>{format.date(lateEvening)}</time>;
}

afterEach(() => {
  cleanup();
  __resetDictionaryRegistry();
});

describe("useFormatter", () => {
  test("formats in the payload's zone, defaulting to UTC", () => {
    render(
      <Page>
        <When />
      </Page>,
    );
    expect(screen.getByRole("time").textContent).toBe("Nov 1, 2026");
  });

  test("follows the zone the server shipped", () => {
    render(
      <Page timeZone="Europe/Istanbul">
        <When />
      </Page>,
    );
    expect(screen.getByRole("time").textContent).toBe("Nov 2, 2026");
  });

  test("a hook-level zone overrides the payload's", () => {
    render(
      <Page timeZone="Europe/Istanbul">
        <When timeZone="UTC" />
      </Page>,
    );
    expect(screen.getByRole("time").textContent).toBe("Nov 1, 2026");
  });

  test("uses the page's locale", () => {
    render(
      <Page locale="tr-TR" supportedLocales={["en-US", "tr-TR"]} defaultLocale="en-US">
        <When />
      </Page>,
    );
    expect(screen.getByRole("time").textContent).toBe("1 Kas 2026");
  });

  /**
   * The point of shipping the zone: the server render and the hydrating render
   * produce the same text whatever zone either runtime sits in.
   */
  test("server and browser renders print the same date", () => {
    const tree = (
      <Page timeZone="Asia/Tokyo">
        <When />
      </Page>
    );
    const server = renderToString(tree);
    render(tree);
    expect(server).toContain(screen.getByRole("time").textContent!);
    expect(screen.getByRole("time").textContent).toBe("Nov 2, 2026");
  });
});

describe("useDictionary(...).format", () => {
  const dict = defineDictionary({
    title: { "en-US": "Orders", "tr-TR": "Siparişler" },
  });

  function Orders() {
    const t = useDictionary(dict);
    return (
      <p>
        {t("title")}: {t.format.date(lateEvening, { day: "numeric", month: "long" })}
      </p>
    );
  }

  test("formats in the dictionary's locale and the page's zone", () => {
    render(
      <Page locale="tr-TR" supportedLocales={["en-US", "tr-TR"]} timeZone="Europe/Istanbul">
        <Orders />
      </Page>,
    );
    expect(screen.getByText(/Siparişler/).textContent).toBe("Siparişler: 2 Kasım");
  });
});
