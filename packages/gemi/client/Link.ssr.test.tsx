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
