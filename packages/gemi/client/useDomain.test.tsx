/** @vitest-environment node */
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";

import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { useDomain } from "./useDomain";

/**
 * What a page reads back about the host it was served on. Rendered rather than
 * called directly: `useDomain` reads the server's payload through context, and
 * the same values have to come out during the server render, which is where a
 * mismatch would show up as a hydration error.
 */

type Domain = NonNullable<ServerDataContextValue["router"]["domain"]>;

const acme: Domain = {
  host: "acme.gemi.dev",
  group: ":tenant",
  params: { tenant: "acme" },
  custom: false,
  root: "gemi.dev",
  origin: "http://acme.gemi.dev:5173",
};

function renderDomain<T>(
  domain: Domain | null | undefined,
  read: (d: ReturnType<typeof useDomain>) => T,
): T {
  let seen!: T;
  function Probe() {
    seen = read(useDomain());
    return null;
  }
  renderToString(
    <ServerDataContext.Provider value={{ router: { domain } } as unknown as ServerDataContextValue}>
      <Probe />
    </ServerDataContext.Provider>,
  );
  return seen;
}

describe("useDomain fields", () => {
  test("reports the host group the server served the page under", () => {
    const seen = renderDomain(acme, ({ host, group, params, custom }) => ({
      host,
      group,
      params,
      custom,
    }));

    expect(seen).toEqual({
      host: "acme.gemi.dev",
      group: ":tenant",
      params: { tenant: "acme" },
      custom: false,
    });
  });

  test("a custom domain reads as one, with its group's params", () => {
    const seen = renderDomain(
      { ...acme, host: "app.acme.com", custom: true, origin: "https://app.acme.com" },
      ({ host, custom, params }) => ({ host, custom, params }),
    );

    expect(seen).toEqual({
      host: "app.acme.com",
      custom: true,
      params: { tenant: "acme" },
    });
  });

  test("is empty, not a crash, when the app declares no `route.domains`", () => {
    const seen = renderDomain(null, ({ host, group, params, custom }) => ({
      host,
      group,
      params,
      custom,
    }));

    expect(seen).toEqual({ host: null, group: null, params: {}, custom: false });
  });
});

describe("useDomain().url", () => {
  test("links to another host of the app, keeping the served origin", () => {
    const seen = renderDomain(acme, (d) => ({
      admin: d.url({ subdomain: "admin" }, "/users/7"),
      apex: d.url({}, "/pricing"),
      custom: d.url({ host: "app.acme.com" }, "/users/7"),
    }));

    expect(seen).toEqual({
      admin: "http://admin.gemi.dev:5173/users/7",
      apex: "http://gemi.dev:5173/pricing",
      custom: "http://app.acme.com:5173/users/7",
    });
  });

  test("defaults to the other host's root path", () => {
    const seen = renderDomain(acme, (d) => d.url({ subdomain: "admin" }));

    expect(seen).toBe("http://admin.gemi.dev:5173/");
  });

  // The origin comes from the server's payload, not `window.location`, so the
  // same URL is produced during the server render — hence a page without
  // `route.domains` has nothing to build from and says so.
  test("without `route.domains` it throws the documented error", () => {
    expect(() => renderDomain(null, (d) => d.url({ subdomain: "admin" }))).toThrow(
      "`useDomain().url` needs `route.domains` to be configured.",
    );
  });
});
