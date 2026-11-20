/** @vitest-environment node */
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";

import { Link } from "./Link";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { RouteTransitionProvider } from "./RouteTransitionProvider";

/**
 * `data-pending` is what a link's spinner or dimmed state hangs off, and it is
 * only readable from the markup — hence rendering rather than asserting on the
 * comparison itself.
 */
function renderLink(
  ui: React.ReactNode,
  transitionTarget: string,
  state: Partial<RouteState & PageData> = {},
) {
  return renderToString(
    <RouteStateProvider
      state={
        {
          pathname: "/",
          search: "",
          hash: "",
          params: {},
          locale: null,
          ...state,
        } as RouteState & PageData
      }
    >
      <RouteTransitionProvider
        isPending
        isFetching={false}
        transitionPath={["/", transitionTarget]}
      >
        {ui}
      </RouteTransitionProvider>
    </RouteStateProvider>,
  );
}

describe("Link data-pending", () => {
  test("marks the parameterised link the navigation is heading to", () => {
    const html = renderLink(
      <Link href={"/app/:orgId/lists" as never} params={{ orgId: "f-An0" }}>
        Lists
      </Link>,
      "/app/f-An0/lists",
    );

    expect(html).toContain('data-pending="true"');
  });

  test("leaves the other rows of a shared template alone", () => {
    const html = renderLink(
      <>
        <Link
          href={"/app/:orgId/lists/:listId" as never}
          params={{ orgId: "f-An0", listId: "one" }}
        >
          One
        </Link>
        <Link
          href={"/app/:orgId/lists/:listId" as never}
          params={{ orgId: "f-An0", listId: "two" }}
        >
          Two
        </Link>
      </>,
      "/app/f-An0/lists/two",
    );

    const pending = html.match(/data-pending="true"/g) ?? [];
    expect(pending).toHaveLength(1);
    expect(html).toMatch(/data-pending="true"[^>]*>Two</);
  });

  test("handles the root route, whose resolved path is empty", () => {
    const html = renderLink(<Link href={"/" as never}>Home</Link>, "/");

    expect(html).toContain('data-pending="true"');
  });

  test("stays false while nothing is in flight", () => {
    const html = renderToString(
      <RouteStateProvider
        state={
          {
            pathname: "/",
            search: "",
            hash: "",
            params: {},
            locale: null,
          } as RouteState & PageData
        }
      >
        <RouteTransitionProvider
          isPending={false}
          isFetching={false}
          transitionPath={["/", "/app/f-An0/lists"]}
        >
          <Link href={"/app/:orgId/lists" as never} params={{ orgId: "f-An0" }}>
            Lists
          </Link>
        </RouteTransitionProvider>
      </RouteStateProvider>,
    );

    expect(html).toContain('data-pending="false"');
  });
});

describe("Link to another host", () => {
  test("renders the absolute URL as a plain anchor, outside the router", () => {
    // No router providers at all: an external link must not need them.
    const html = renderToString(
      <Link href="http://admin.gemi.dev:5173/users/7" className="x">
        Admin
      </Link>,
    );

    expect(html).toBe(
      '<a data-active="false" href="http://admin.gemi.dev:5173/users/7" class="x">Admin</a>',
    );
  });
});

describe("Link href to the root route (#1257)", () => {
  function hrefOf(html: string) {
    return html.match(/href="([^"]*)"/)?.[1];
  }

  test("keeps the root path in front of a search", () => {
    const html = renderLink(
      <Link href={"/" as never} search={{ a: "1" } as never}>
        Home
      </Link>,
      "/elsewhere",
      { pathname: "/elsewhere" },
    );

    expect(hrefOf(html)).toBe("/?a=1");
  });

  test("keeps the root path in front of a hash, with and without a search", () => {
    const withSearch = renderLink(
      <Link href={"/" as never} search={{ a: "1" } as never} hash="#x">
        Home
      </Link>,
      "/elsewhere",
      { pathname: "/elsewhere" },
    );
    const hashOnly = renderLink(
      <Link href={"/" as never} hash="#x">
        Home
      </Link>,
      "/elsewhere",
      { pathname: "/elsewhere" },
    );

    expect(hrefOf(withSearch)).toBe("/?a=1#x");
    expect(hrefOf(hashOnly)).toBe("/#x");
  });

  test("an optional param left out resolves to the root", () => {
    const html = renderLink(
      <Link
        href={"/:section?" as never}
        params={{} as never}
        search={{ a: "1" } as never}
      >
        Home
      </Link>,
      "/elsewhere",
      { pathname: "/elsewhere" },
    );

    expect(hrefOf(html)).toBe("/?a=1");
  });

  test("is active on / with the same search", () => {
    const html = renderLink(
      <Link href={"/" as never} search={{ a: "1" } as never}>
        Home
      </Link>,
      "/",
      { pathname: "/", search: "?a=1" },
    );

    expect(html).toContain('data-active="true"');
  });
});

describe("Link href from decoded route params (#1322)", () => {
  test.each([
    ["a/b", "/notes/a%2Fb/edit"],
    ["100%", "/notes/100%25/edit"],
    ["a b", "/notes/a%20b/edit"],
  ])("on the page for %j, an implicit-param link points at %s", (id, href) => {
    // `useParams()` holds the decoded ID; `Link` falls back to it.
    const html = renderLink(<Link href={"/notes/:id/edit" as never}>Edit</Link>, "/", {
      params: { id },
    });
    expect(html).toContain(`href="${href}"`);
  });

  test("a wildcard keeps its slashes", () => {
    const html = renderLink(
      <Link href={"/files/:src*" as never} params={{ src: "a/b c" } as never}>
        File
      </Link>,
      "/",
    );
    expect(html).toContain('href="/files/a/b%20c"');
  });
});
