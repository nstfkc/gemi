/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useFeature, useFeatures } from "./useFeature";

function state(features?: Record<string, unknown>): RouteState & PageData {
  return { features, data: {}, prefetchedData: {} } as any;
}

function Show({ feature }: { feature: string }) {
  return <span data-testid="value">{JSON.stringify(useFeature(feature as never))}</span>;
}

function renderWith(value: RouteState & PageData, ui = <Show feature="new-checkout" />) {
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

  test("is always a boolean", () => {
    renderWith(state({ "new-checkout": false }));

    expect(screen.getByTestId("value").textContent).toBe("false");
  });

  test("a non-boolean in the payload does not leak through", () => {
    // Nothing should ever put one there, but `useFeature`'s contract is a
    // boolean and a component branching on it must not receive a string.
    renderWith(state({ "new-checkout": "yes" }));

    expect(screen.getByTestId("value").textContent).toBe("false");
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

  test("a feature that is off does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWith(state({ "new-checkout": false }));

    expect(screen.getByTestId("value").textContent).toBe("false");
    expect(warn).not.toHaveBeenCalled();
  });

  test("an unknown key warns in development", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWith(state({}));

    expect(warn.mock.calls.flat().join(" ")).toMatch(
      /Feature "new-checkout" is not in the payload/,
    );
    // Both causes named. "Declare it in app/features" alone is wrong advice for
    // the app that already did, then marked the feature `serverOnly`.
    expect(warn.mock.calls.flat().join(" ")).toMatch(/serverOnly/);
  });

  test("a new navigation's values replace the old ones", () => {
    // The per-navigation refresh contract: re-rendering the provider with the
    // envelope's features must change what components see, with no refetch.
    const { rerender } = renderWith(state({ "new-checkout": false }));
    expect(screen.getByTestId("value").textContent).toBe("false");

    rerender(
      <RouteStateProvider state={state({ "new-checkout": true })}>
        <Show feature="new-checkout" />
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
    renderWith(state({ a: true, b: false }), <All />);

    expect(JSON.parse(screen.getByTestId("value").textContent!)).toEqual({
      a: true,
      b: false,
    });
  });

  test("is an empty object when the server sent nothing", () => {
    function All() {
      return <span data-testid="value">{JSON.stringify(useFeatures())}</span>;
    }
    renderWith(state(undefined), <All />);

    expect(screen.getByTestId("value").textContent).toBe("{}");
  });
});
