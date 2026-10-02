/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * A `Link` click is the router's only when it is a plain primary click the
 * caller has not cancelled. Everything else (a new tab, a download, a middle
 * click) belongs to the browser, as it would for a plain anchor (#694).
 */

const push = vi.fn();
const prefetch = vi.fn();

vi.mock("./useNavigate", () => ({
  useNavigate: () => ({ push, replace: vi.fn() }),
}));
vi.mock("./usePrefetch", () => ({
  usePrefetch: () => prefetch,
}));

import { Link } from "./Link";
import { I18nContext } from "./I18nContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { RouteTransitionProvider } from "./RouteTransitionProvider";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** Whether the click reached the document still cancelled, i.e. the router took it. */
let lastClickPrevented: boolean | null;

function recordClick(event: Event) {
  lastClickPrevented = event.defaultPrevented;
  // jsdom cannot navigate; stop it from trying once the outcome is recorded.
  event.preventDefault();
}

beforeEach(() => {
  push.mockClear();
  prefetch.mockClear();
  lastClickPrevented = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  document.addEventListener("click", recordClick);
});

afterEach(() => {
  document.removeEventListener("click", recordClick);
  act(() => root.unmount());
  container.remove();
});

function render(ui: ReactNode, pathname = "/") {
  act(() => {
    root.render(
      <I18nContext.Provider value={{ defaultLocale: "en-US" } as any}>
        <RouteStateProvider
          state={
            {
              pathname,
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
            transitionPath={[pathname, pathname]}
          >
            {ui}
          </RouteTransitionProvider>
        </RouteStateProvider>
      </I18nContext.Provider>,
    );
  });
  return container.querySelector("a")!;
}

function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
  act(() => {
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
}

describe("Link click", () => {
  test("a plain primary click navigates client-side", () => {
    const anchor = render(<Link href={"/about" as never}>About</Link>);
    click(anchor);

    expect(push).toHaveBeenCalledTimes(1);
    expect(lastClickPrevented).toBe(true);
  });

  test("target=\"_self\" is still the router's", () => {
    const anchor = render(
      <Link href={"/about" as never} target="_self">
        About
      </Link>,
    );
    click(anchor);

    expect(push).toHaveBeenCalledTimes(1);
    expect(lastClickPrevented).toBe(true);
  });

  test.each(["_blank", "_parent", "conversation"])(
    "target=%j is left to the browser",
    (target) => {
      const anchor = render(
        <Link href={"/about" as never} target={target}>
          About
        </Link>,
      );
      click(anchor);

      expect(push).not.toHaveBeenCalled();
      expect(lastClickPrevented).toBe(false);
    },
  );

  test.each(["metaKey", "ctrlKey", "shiftKey", "altKey"] as const)(
    "a %s click is left to the browser",
    (modifier) => {
      const anchor = render(<Link href={"/about" as never}>About</Link>);
      click(anchor, { [modifier]: true });

      expect(push).not.toHaveBeenCalled();
      expect(lastClickPrevented).toBe(false);
    },
  );

  test("a non-primary button is left to the browser", () => {
    const anchor = render(<Link href={"/about" as never}>About</Link>);
    click(anchor, { button: 1 });

    expect(push).not.toHaveBeenCalled();
    expect(lastClickPrevented).toBe(false);
  });

  test("a download link is left to the browser", () => {
    const anchor = render(
      <Link href={"/about" as never} download>
        About
      </Link>,
    );
    click(anchor);

    expect(push).not.toHaveBeenCalled();
    expect(lastClickPrevented).toBe(false);
  });

  test("the caller's onClick runs first and can cancel the navigation", () => {
    const order: string[] = [];
    push.mockImplementation(() => order.push("push"));
    const anchor = render(
      <Link
        href={"/about" as never}
        onClick={(event) => {
          order.push("onClick");
          event.preventDefault();
        }}
      >
        About
      </Link>,
    );
    click(anchor);

    expect(order).toEqual(["onClick"]);
    expect(push).not.toHaveBeenCalled();
    push.mockReset();
  });

  test("the caller's onClick runs before a client-side navigation", () => {
    const order: string[] = [];
    push.mockImplementation(() => order.push("push"));
    const anchor = render(
      <Link href={"/about" as never} onClick={() => order.push("onClick")}>
        About
      </Link>,
    );
    click(anchor);

    expect(order).toEqual(["onClick", "push"]);
    push.mockReset();
  });

  test("the caller's onClick still runs on a click left to the browser", () => {
    const onClick = vi.fn();
    const anchor = render(
      <Link href={"/about" as never} target="_blank" onClick={onClick}>
        About
      </Link>,
    );
    click(anchor);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  test("a cmd-click on the current page opens it in a new tab", () => {
    const anchor = render(<Link href={"/about" as never}>About</Link>, "/about");
    click(anchor, { metaKey: true });

    expect(lastClickPrevented).toBe(false);
  });

  test("a plain click on the current page does nothing", () => {
    const anchor = render(<Link href={"/about" as never}>About</Link>, "/about");
    click(anchor);

    expect(push).not.toHaveBeenCalled();
    expect(lastClickPrevented).toBe(true);
  });
});

describe("Link hover prefetch", () => {
  test("still warms the route on mouse enter", () => {
    const anchor = render(
      <Link href={"/about" as never} prefetch="hover" target="_blank">
        About
      </Link>,
    );
    act(() => {
      anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });

    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch.mock.calls[0][0]).toBe("/about");
  });
});
