/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";

const push = vi.fn();
const replace = vi.fn();

// `useNavigate` returns `action("push")` and `action("replace")`, built fresh
// on every render. A mock that returned one stable pair could not show what
// depending on them does.
vi.mock("./useNavigate", () => ({
  useNavigate: () => ({
    push: (...args: unknown[]) => push(...args),
    replace: (...args: unknown[]) => replace(...args),
  }),
}));

const { Redirect } = await import("./Redirect");

afterEach(() => {
  cleanup();
  push.mockClear();
  replace.mockClear();
});

/** Renders `children` under a parent this test can re-render on demand. */
function mountWithRerender(render_: (n: number) => React.ReactNode) {
  let bump!: () => void;
  function Parent() {
    const [n, setN] = useState(0);
    bump = () => setN((x) => x + 1);
    return <>{render_(n)}</>;
  }
  render(<Parent />);
  return async () => {
    await act(async () => {
      bump();
    });
  };
}

describe("Redirect", () => {
  /**
   * The redirect is one navigation, not one per render. `push` and `replace`
   * are rebuilt every render and the `params`/`search` defaults are new
   * objects, so an effect depending on them fired every time anything above
   * this re-rendered — pushing a history entry each round.
   */
  test("navigates once, however often its parent re-renders", async () => {
    const rerender = mountWithRerender(() => (
      <Redirect action="push" href={"/dashboard" as never} />
    ));
    expect(push).toHaveBeenCalledOnce();

    await rerender();
    await rerender();
    await rerender();

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/dashboard", { params: {}, search: {} });
  });

  test("replace is the default, and is also only run once", async () => {
    const rerender = mountWithRerender(() => <Redirect href={"/dashboard" as never} />);
    await rerender();

    expect(replace).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  /** A new destination is a new navigation — the guard is on the target. */
  test("navigates again when the destination changes", async () => {
    const rerender = mountWithRerender((n) => (
      <Redirect
        action="push"
        href={"/partial/:orgId/reports" as never}
        params={{ orgId: `org-${n}` } as never}
      />
    ));
    expect(push).toHaveBeenCalledOnce();

    await rerender();

    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith("/partial/:orgId/reports", {
      params: { orgId: "org-1" },
      search: {},
    });
  });
});
