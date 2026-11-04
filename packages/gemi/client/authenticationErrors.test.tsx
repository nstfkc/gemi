/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Suspense, act } from "react";
import { cleanup, render, renderHook } from "@testing-library/react";

import { QueryManagerProvider } from "./QueryManagerContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { ServerDataContext } from "./ServerDataProvider";
import { useQuery } from "./useQuery";
import { useMutation } from "./useMutation";
import {
  AUTHENTICATION_RECHECK_DELAY_MS,
  MAX_AUTHENTICATION_RECHECKS,
  configureAuthenticationErrors,
  isAuthenticationRefusal,
  reportAuthenticationRefusal,
  resetAuthenticationErrorsForTests,
  resetAuthenticationIncident,
  setAuthenticationNavigator,
  signInUrlFor,
  type AuthenticationErrorContext,
} from "./authenticationErrors";

/**
 * `onAuthenticationError` (#1119): an `/api` query or mutation on an open page
 * refused because the session ended. Off by default; when on, confirmed with
 * one uncached `/auth/me` before anything happens, once per incident.
 */

const AUTHENTICATION = { error: { kind: "authentication", message: "Authentication error", status: 401 } };
const AUTHORIZATION = { error: { kind: "authorization", message: "Not your invoice", status: 401 } };
const PERMISSION = { error: { kind: "permission", message: "Insufficient permissions", status: 403 } };

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** Answers by path: `/auth/me` and everything else are scripted separately. */
function network() {
  const answers = new Map<string, Answer>();
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const path = url.replace(/^\/api/, "").split("?")[0];
    const answer = answers.get(path) ?? answers.get("*") ?? { status: 200, body: [] };
    return new Response(JSON.stringify(answer.body ?? null), {
      status: answer.status,
      headers: { "Content-Type": "application/json", ...answer.headers },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    answer(path: string, answer: Answer) {
      answers.set(path, answer);
    },
    calls: (path: string) =>
      fetchMock.mock.calls.filter(([url]) => url.replace(/^\/api/, "").split("?")[0] === path),
  };
}

const signedOut = (headers: Record<string, string> = { "x-gemi-sign-in": "/auth/sign-in" }) => ({
  status: 401,
  body: AUTHENTICATION,
  headers,
});

let net: ReturnType<typeof network>;
let replace: ReturnType<typeof vi.fn>;
let page: { pathname: string; search: string };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetAuthenticationErrorsForTests();
  net = network();
  replace = vi.fn();
  page = { pathname: "/invoices", search: "?page=2" };
  setAuthenticationNavigator({ replace, current: () => page });
});

afterEach(() => {
  cleanup();
  resetAuthenticationErrorsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(ms = AUTHENTICATION_RECHECK_DELAY_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function Providers(props: { children: React.ReactNode }) {
  return (
    <ServerDataContext.Provider value={{} as any}>
      <QueryManagerProvider>
        <RouteStateProvider state={{ pathname: "/invoices", search: "?page=2" } as RouteState & PageData}>
          <Suspense fallback={null}>{props.children}</Suspense>
        </RouteStateProvider>
      </QueryManagerProvider>
    </ServerDataContext.Provider>
  );
}

const refetchers: Record<string, () => void> = {};
function Query(props: { path: string }) {
  const { data, error, refetch } = useQuery(props.path as any, {}, {
    suspense: false,
    revalidateOnFocus: false,
  } as any) as any;
  refetchers[props.path] = refetch;
  return <div>{`${props.path} data:${JSON.stringify(data ?? null)} error:${error?.status ?? "none"}`}</div>;
}

/** Mounts the queries with data, then expires the session and refetches them. */
async function expireOnOpenPage(paths: string[], refusal: Answer = signedOut()) {
  const view = render(
    <Providers>
      {paths.map((path) => (
        <Query key={path} path={path} />
      ))}
    </Providers>,
  );
  await act(async () => {});
  for (const path of paths) net.answer(path, refusal);
  net.answer("/auth/me", refusal);
  await act(async () => {
    for (const path of paths) refetchers[path]();
  });
  return view;
}

describe("off by default", () => {
  test("a refused query keeps its data and its error, and nothing is checked or navigated", async () => {
    const view = await expireOnOpenPage(["/todos"]);
    await settle(60_000);

    expect(view.container.textContent).toBe("/todos data:[] error:401");
    expect(net.calls("/auth/me")).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('onAuthenticationError: "redirect"', () => {
  beforeEach(() => configureAuthenticationErrors("redirect"));

  test("a query refused for authentication sends the tab to sign-in, after one uncached check", async () => {
    await expireOnOpenPage(["/todos"]);
    expect(replace).not.toHaveBeenCalled();

    await settle();

    const checks = net.calls("/auth/me");
    expect(checks).toHaveLength(1);
    expect((checks[0][1] as RequestInit).cache).toBe("no-store");
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2");
  });

  test("uses the sign-in path the server refused with", async () => {
    await expireOnOpenPage(["/todos"], signedOut({ "x-gemi-sign-in": "/admin/sign-in" }));
    await settle();

    expect(replace).toHaveBeenCalledWith("/admin/sign-in?redirect=%2Finvoices%3Fpage%3D2");
  });

  test("concurrent failures are one incident: one check, one redirect", async () => {
    await expireOnOpenPage(["/todos", "/invoices", "/notifications"]);
    await settle();
    await settle(60_000);

    expect(net.calls("/auth/me")).toHaveLength(1);
    expect(replace).toHaveBeenCalledOnce();
  });

  test("authorization and permission refusals are never acted on", async () => {
    await expireOnOpenPage(["/todos"], { status: 401, body: AUTHORIZATION });
    await expireOnOpenPage(["/reports"], { status: 403, body: PERMISSION });
    await expireOnOpenPage(["/legacy"], { status: 401, body: { error: "Not your invoice" } });
    await settle(60_000);

    expect(net.calls("/auth/me")).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();
  });

  test("a legacy string refusal is recognised", async () => {
    await expireOnOpenPage(["/todos"], { status: 401, body: { error: "Authentication error" } });
    await settle();

    expect(replace).toHaveBeenCalledOnce();
    // No header from that server: the default sign-in path.
    expect(replace).toHaveBeenCalledWith("/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2");
  });

  test("a check that finds the session alive fetches the failed queries again, and does not redirect", async () => {
    const view = await expireOnOpenPage(["/todos"]);
    net.answer("/auth/me", { status: 200, body: { id: 1 } });
    net.answer("/todos", { status: 200, body: ["fresh"] });

    await settle();

    expect(replace).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe('/todos data:["fresh"] error:none');
  });

  test("a check that gets no clear answer does not redirect", async () => {
    await expireOnOpenPage(["/todos"]);
    net.answer("/auth/me", { status: 503, body: null });

    await settle();

    expect(replace).not.toHaveBeenCalled();
  });

  test("a route refused while /auth/me says signed in is checked a bounded number of times", async () => {
    await expireOnOpenPage(["/todos"]);
    net.answer("/auth/me", { status: 200, body: { id: 1 } });

    for (let i = 0; i < 6; i++) await settle();

    expect(net.calls("/auth/me")).toHaveLength(MAX_AUTHENTICATION_RECHECKS);
    expect(replace).not.toHaveBeenCalled();
  });

  test("/auth/me itself being refused is not an incident: that is how a public page learns nobody is signed in", async () => {
    reportAuthenticationRefusal({
      source: "query",
      path: "/auth/me",
      status: 401,
      body: AUTHENTICATION,
      headers: null,
      error: new Error("401"),
    });
    await settle(60_000);

    expect(net.calls("/auth/me")).toHaveLength(0);
  });

  test("the sign-in page is never sent to itself", async () => {
    page = { pathname: "/auth/sign-in", search: "" };
    await expireOnOpenPage(["/todos"]);
    await settle();

    expect(replace).not.toHaveBeenCalled();
  });

  test("a mutation refused for authentication redirects, and its caller still gets the error", async () => {
    net.answer("*", signedOut());
    const onError = vi.fn();
    const { result } = renderHook(() => useMutation("POST" as never, "/invoices" as never, {} as never, { onError } as never));

    await act(() => result.current.trigger({} as never));

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({ kind: "authentication", status: 401 });
    expect(result.current.error).toMatchObject({ kind: "authentication" });

    await settle();
    expect(replace).toHaveBeenCalledWith("/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2");
  });

  test("a new page is a new incident", async () => {
    await expireOnOpenPage(["/todos"]);
    await settle();
    expect(replace).toHaveBeenCalledOnce();

    // Signed in again, back on a page, and the session ends once more.
    cleanup();
    resetAuthenticationIncident();
    await expireOnOpenPage(["/todos"]);
    await settle();

    expect(replace).toHaveBeenCalledTimes(2);
  });

  test("a sign-in page on another origin gets a full load and the path only", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace: assign });
    await expireOnOpenPage(["/todos"], signedOut({ "x-gemi-sign-in": "https://sso.example/login" }));
    await settle();

    expect(replace).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("https://sso.example/login?redirect=%2Finvoices");
  });
});

describe("onAuthenticationError: a function", () => {
  test("is called once with the context, and decides itself", async () => {
    const seen: AuthenticationErrorContext[] = [];
    configureAuthenticationErrors((ctx) => seen.push(ctx));

    await expireOnOpenPage(["/todos", "/invoices"]);
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      source: "query",
      signInUrl: "/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2",
    });
    expect(["/todos", "/invoices"]).toContain(seen[0].path);
    expect((seen[0].error as any).status).toBe(401);
    // Nothing navigated unless the hook asks for it.
    expect(replace).not.toHaveBeenCalled();

    seen[0].redirect();
    expect(replace).toHaveBeenCalledWith("/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2");
  });

  test("a hook that throws does not break the page", async () => {
    configureAuthenticationErrors(() => {
      throw new Error("boom");
    });
    await expireOnOpenPage(["/todos"]);
    await expect(settle()).resolves.toBeUndefined();
  });
});

describe("helpers", () => {
  test("isAuthenticationRefusal reads the kind, or the legacy message", () => {
    expect(isAuthenticationRefusal(401, AUTHENTICATION)).toBe(true);
    expect(isAuthenticationRefusal(401, { error: "Authentication error" })).toBe(true);
    expect(isAuthenticationRefusal(401, AUTHORIZATION)).toBe(false);
    expect(isAuthenticationRefusal(401, { error: "Not authorized" })).toBe(false);
    expect(isAuthenticationRefusal(403, PERMISSION)).toBe(false);
    expect(isAuthenticationRefusal(401, null)).toBe(false);
    expect(isAuthenticationRefusal(500, AUTHENTICATION)).toBe(false);
  });

  test("signInUrlFor", () => {
    expect(signInUrlFor("/login", { pathname: "/a", search: "?x=1" })).toBe("/login?redirect=%2Fa%3Fx%3D1");
    expect(signInUrlFor("/login?next=1", { pathname: "/a", search: "" })).toBe("/login?next=1&redirect=%2Fa");
    expect(signInUrlFor("/login", { pathname: "/login/", search: "" })).toBeNull();
    expect(signInUrlFor("https://sso.example/in", { pathname: "/a", search: "?token=s" })).toBe(
      "https://sso.example/in?redirect=%2Fa",
    );
  });
});
