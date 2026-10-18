/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { QueryManagerProvider } from "../QueryManagerContext";
import { RouteStateProvider, type PageData, type RouteState } from "../RouteStateContext";
import { ServerDataContext } from "../ServerDataProvider";
import { useSignOut } from "./useSignOut";
import { useUser } from "./useUser";

vi.mock("../realtime/loader", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconnectRealtime: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** `/auth/me` sits behind the `auth` middleware: signed out, it answers 401. */
function stubSignedOutServer() {
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "POST" && url.endsWith("/auth/sign-out")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (method === "GET" && url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function Account(props: { onSignOut?: () => void }) {
  const { user } = useUser();
  const { trigger } = useSignOut({ onSuccess: props.onSignOut });
  return user ? (
    <button onClick={() => trigger()}>Sign out {(user as any).email}</button>
  ) : (
    <span>Sign in</span>
  );
}

function renderSignedIn(onSignOut?: () => void) {
  return render(
    <ServerDataContext.Provider
      value={{ auth: { user: { id: 1, email: "a@b.co" } } } as any}
    >
      <QueryManagerProvider>
        <RouteStateProvider state={{ params: {} } as unknown as RouteState & PageData}>
          <Account onSignOut={onSignOut} />
        </RouteStateProvider>
      </QueryManagerProvider>
    </ServerDataContext.Provider>,
  );
}

test("signing out clears the user without a page refresh", async () => {
  stubSignedOutServer();
  renderSignedIn(() => {});

  await act(async () => screen.getByRole("button").click());

  expect(await screen.findByText("Sign in")).toBeTruthy();
});

test("the user is cleared even when the onSuccess callback throws", async () => {
  stubSignedOutServer();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  renderSignedIn(() => {
    throw new Error("app callback failed");
  });

  await act(async () => screen.getByRole("button").click());

  expect(await screen.findByText("Sign in")).toBeTruthy();
  error.mockRestore();
});

test("useSignOut({}) works without an onSuccess callback", async () => {
  stubSignedOutServer();
  renderSignedIn();

  await act(async () => screen.getByRole("button").click());

  expect(await screen.findByText("Sign in")).toBeTruthy();
});
