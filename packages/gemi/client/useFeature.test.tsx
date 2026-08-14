/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useFeature, useFeatures } from "./useFeature";

function state(features?: Record<string, unknown>): RouteState & PageData {
  return { features, data: {}, prefetchedData: {} } as any;
}

function Show({ flag }: { flag: string }) {
  return <span data-testid="value">{JSON.stringify(useFeature(flag as never))}</span>;
}

function renderWith(value: RouteState & PageData, ui = <Show flag="new-checkout" />) {
  return render(<RouteStateProvider state={value}>{ui}</RouteStateProvider>);
}

// Auto-cleanup needs vitest globals, which this repo doesn't enable.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useFeature", () => {
  test("reads the value the server sent", () => {
    renderWith(state({ "new-checkout": true }));

    expect(screen.getByTestId("value").textContent).toBe("true");
  });

  test("carries multivariate values through", () => {
    renderWith(state({ "pricing-page": "b" }), <Show flag="pricing-page" />);

    expect(screen.getByTestId("value").textContent).toBe('"b"');
  });

  test("numeric flags survive", () => {
    renderWith(state({ "seat-limit": 12 }), <Show flag="seat-limit" />);

    expect(screen.getByTestId("value").textContent).toBe("12");
  });

  test("an unknown key is false rather than a crash", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWith(state({}));

    expect(screen.getByTestId("value").textContent).toBe("false");
  });

  test("missing features on the state is tolerated", () => {
    // An error-path envelope, or a test that passes bare page data.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWith(state(undefined));

    expect(screen.getByTestId("value").textContent).toBe("false");
  });

  test("a false flag does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWith(state({ "new-checkout": false }));

    expect(screen.getByTestId("value").textContent).toBe("false");
    expect(warn).not.toHaveBeenCalled();
  });

  test("an unknown key warns in development", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWith(state({}));

    expect(warn.mock.calls.flat().join(" ")).toMatch(/Unknown feature flag "new-checkout"/);
  });

  test("a new navigation's values replace the old ones", () => {
    // The per-navigation refresh contract: re-rendering the provider with the
    // envelope's flags must change what components see, with no refetch.
    const { rerender } = renderWith(state({ "new-checkout": false }));
    expect(screen.getByTestId("value").textContent).toBe("false");

    rerender(
      <RouteStateProvider state={state({ "new-checkout": true })}>
        <Show flag="new-checkout" />
      </RouteStateProvider>,
    );

    expect(screen.getByTestId("value").textContent).toBe("true");
  });
});

describe("useFeatures", () => {
  test("returns the whole map", () => {
    function All() {
      return <span data-testid="value">{JSON.stringify(useFeatures())}</span>;
    }
    renderWith(state({ a: true, b: "x" }), <All />);

    expect(JSON.parse(screen.getByTestId("value").textContent!)).toEqual({ a: true, b: "x" });
  });

  test("is an empty object when the server sent nothing", () => {
    function All() {
      return <span data-testid="value">{JSON.stringify(useFeatures())}</span>;
    }
    renderWith(state(undefined), <All />);

    expect(screen.getByTestId("value").textContent).toBe("{}");
  });
});
