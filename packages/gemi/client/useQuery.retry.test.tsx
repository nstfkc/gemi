/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Suspense, act, useState } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render } from "@testing-library/react";

import { QueryManagerProvider, type QueryConfig } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { ServerDataContext } from "./ServerDataProvider";
import { useQuery } from "./useQuery";
import { useInfiniteQuery } from "./useInfiniteQuery";
import { useUser } from "./auth/useUser";
import { QueryError } from "./QueryError";
import {
  isRetryableQueryError,
  parseRetryAfter,
  retryDelayFor,
  shouldRetryQuery,
} from "./retryPolicy";

/**
 * The retry policy for `suspense: false` queries (issue #421). A failed query
 * used to re-arm the same 10s timer on every error, whatever the status, so a
 * 401 from `useUser()` on a public page polled `/auth/me` forever. Now only
 * failures another attempt might fix (network, 408, 429, 5xx) are retried, at
 * most `retry` times in a row, with exponential backoff and `Retry-After`
 * honoured.
 *
 * All timers are fake: every "nothing else happens" assertion advances the
 * clock by minutes rather than waiting.
 */

type Scripted =
  | { status: number; body?: unknown; retryAfter?: string; html?: boolean }
  | "network";

/**
 * Answers fetches from a script, in order, repeating the last entry once the
 * script runs out — so a query that kept retrying would keep failing and keep
 * being counted.
 */
function createNetwork() {
  let script: Scripted[] = [{ status: 200, body: [] }];
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = script.length > 1 ? script.shift()! : script[0];
    if (next === "network") throw new TypeError("Failed to fetch");
    const headers = new Headers();
    if (next.retryAfter !== undefined) {
      headers.set("retry-after", next.retryAfter);
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers,
      json: async () => {
        if (next.html) throw new SyntaxError("Unexpected token <");
        return next.body;
      },
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    script(...entries: Scripted[]) {
      script = entries;
    },
    calls: () => fetchMock.mock.calls.length,
    urls: () => fetchMock.mock.calls.map(([url]) => url),
  };
}

function Providers(
  props: PropsWithChildren<{
    queryConfig?: QueryConfig;
    auth?: { user: unknown } | undefined;
  }>,
) {
  return (
    <ServerDataContext.Provider value={{ auth: props.auth } as any}>
      <QueryManagerProvider queryConfig={props.queryConfig}>
        <RouteStateProvider state={{} as RouteState & PageData}>
          <Suspense fallback={<div>suspense-fallback</div>}>
            {props.children}
          </Suspense>
        </RouteStateProvider>
      </QueryManagerProvider>
    </ServerDataContext.Provider>
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Five minutes: far past every retry the default policy could schedule. */
const LATER = 5 * 60_000;

let net: ReturnType<typeof createNetwork>;

beforeEach(() => {
  vi.useFakeTimers();
  net = createNetwork();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Todos(props: { config?: Parameters<typeof useQuery>[2] }) {
  const { data, error, loading } = useQuery("/todos" as any, {}, {
    suspense: false,
    ...props.config,
  } as any);
  const status =
    error instanceof QueryError
      ? error.status
      : error
        ? (error as any).name
        : "none";
  return (
    <div>{`data:${data ? JSON.stringify(data) : "none"} error:${status} loading:${loading}`}</div>
  );
}

function renderTodos(
  config?: Parameters<typeof useQuery>[2],
  queryConfig?: QueryConfig,
) {
  return render(
    <Providers queryConfig={queryConfig}>
      <Todos config={config} />
    </Providers>,
  );
}

describe("deterministic client errors are not retried", () => {
  test.each([400, 401, 403, 404, 410, 422])(
    "%i: one request, the error is returned, nothing is scheduled",
    async (status) => {
      net.script({ status, body: { message: "no" } });
      const screen = renderTodos();
      await advance(0);
      expect(
        screen.queryByText(`data:none error:${status} loading:false`),
      ).not.toBeNull();

      await advance(LATER);
      expect(net.calls()).toBe(1);
    },
  );

  test("a non-JSON 404 page is still a 404: a QueryError with a null body, not retried", async () => {
    net.script({ status: 404, html: true });
    let seen: unknown;
    function View() {
      const { error } = useQuery("/todos" as any, {}, { suspense: false });
      seen = error;
      return null;
    }
    render(
      <Providers>
        <View />
      </Providers>,
    );
    await advance(LATER);
    expect(seen).toBeInstanceOf(QueryError);
    expect((seen as QueryError).status).toBe(404);
    expect((seen as QueryError).body).toBeNull();
    expect(net.calls()).toBe(1);
  });
});

describe("transient failures are retried, capped, with backoff", () => {
  test("5xx: three retries at 1s, 2s and 4s, then it stops", async () => {
    net.script({ status: 503, body: { message: "down" } });
    const screen = renderTodos();
    await advance(0);
    expect(net.calls()).toBe(1);

    await advance(999);
    expect(net.calls()).toBe(1);
    await advance(1);
    expect(net.calls()).toBe(2);

    await advance(1999);
    expect(net.calls()).toBe(2);
    await advance(1);
    expect(net.calls()).toBe(3);

    await advance(3999);
    expect(net.calls()).toBe(3);
    await advance(1);
    expect(net.calls()).toBe(4);

    await advance(LATER);
    expect(net.calls()).toBe(4);
    expect(
      screen.queryByText("data:none error:503 loading:false"),
    ).not.toBeNull();
  });

  test("network failures (fetch rejects) are retried the same way", async () => {
    net.script("network");
    const screen = renderTodos();
    await advance(LATER);
    expect(net.calls()).toBe(4);
    expect(
      screen.queryByText("data:none error:TypeError loading:false"),
    ).not.toBeNull();
  });

  test("a non-JSON 502 from a proxy is a 502 and is retried", async () => {
    net.script({ status: 502, html: true });
    renderTodos();
    await advance(LATER);
    expect(net.calls()).toBe(4);
  });

  test("a retry that succeeds shows the data and ends the run", async () => {
    net.script(
      { status: 500 },
      { status: 500 },
      { status: 200, body: [{ id: 1 }] },
    );
    const screen = renderTodos();
    await advance(1000 + 2000);
    expect(net.calls()).toBe(3);
    expect(
      screen.queryByText('data:[{"id":1}] error:none loading:false'),
    ).not.toBeNull();

    await advance(LATER);
    expect(net.calls()).toBe(3);
  });

  test("two readers of one failing query share one retry per failure", async () => {
    net.script({ status: 500 });
    render(
      <Providers>
        <Todos />
        <Todos />
      </Providers>,
    );
    await advance(LATER);
    expect(net.calls()).toBe(4);
  });

  test("unmounting drops the scheduled retry", async () => {
    net.script({ status: 500 });
    const screen = renderTodos();
    await advance(0);
    expect(net.calls()).toBe(1);
    screen.unmount();
    await advance(LATER);
    expect(net.calls()).toBe(1);
  });
});

describe("429", () => {
  test("Retry-After in seconds sets the wait", async () => {
    net.script(
      {
        status: 429,
        retryAfter: "7",
        body: { message: "Rate limit exceeded" },
      },
      { status: 200, body: [] },
    );
    renderTodos();
    await advance(6999);
    expect(net.calls()).toBe(1);
    await advance(1);
    expect(net.calls()).toBe(2);
  });

  test("Retry-After as an HTTP date", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    net.script(
      { status: 429, retryAfter: "Thu, 01 Jan 2026 00:00:30 GMT" },
      { status: 200, body: [] },
    );
    renderTodos();
    await advance(29_999);
    expect(net.calls()).toBe(1);
    await advance(1);
    expect(net.calls()).toBe(2);
  });

  test("without Retry-After it backs off like a 5xx, and is capped", async () => {
    net.script({ status: 429 });
    renderTodos();
    await advance(1000);
    expect(net.calls()).toBe(2);
    await advance(LATER);
    expect(net.calls()).toBe(4);
  });

  test("Retry-After counts toward the cap", async () => {
    net.script({ status: 429, retryAfter: "2" });
    renderTodos();
    await advance(LATER);
    expect(net.calls()).toBe(4);
  });
});

describe("configuration", () => {
  test("per call: retry: false never retries a 5xx", async () => {
    net.script({ status: 500 });
    renderTodos({ retry: false });
    await advance(LATER);
    expect(net.calls()).toBe(1);
  });

  test("per call: a higher cap and a fixed retryDelay", async () => {
    net.script({ status: 500 });
    renderTodos({ retry: 5, retryDelay: 100 });
    await advance(100 * 5);
    expect(net.calls()).toBe(6);
    await advance(LATER);
    expect(net.calls()).toBe(6);
  });

  test("per call: retryDelay as a function of the failure count", async () => {
    net.script({ status: 500 });
    const retryDelay = vi.fn((n: number) => n * 50);
    renderTodos({ retry: 2, retryDelay });
    await advance(50);
    expect(net.calls()).toBe(2);
    await advance(100);
    expect(net.calls()).toBe(3);
    expect(retryDelay.mock.calls.map(([n]) => n)).toEqual([1, 2]);
  });

  test("per call: a retry function decides alone, and may retry a 404", async () => {
    net.script({ status: 404 }, { status: 404 }, { status: 200, body: [] });
    const retry = vi.fn(
      (count: number, error: unknown) =>
        error instanceof QueryError && error.status === 404 && count < 3,
    );
    renderTodos({ retry, retryDelay: 10 });
    await advance(LATER);
    expect(net.calls()).toBe(3);
    expect(retry).toHaveBeenCalledWith(1, expect.any(QueryError));
  });

  test("retry: true retries transient failures with no cap, still never a 4xx", async () => {
    net.script({ status: 500 });
    renderTodos({ retry: true, retryDelay: 1000 });
    await advance(20_000);
    expect(net.calls()).toBe(21);
    cleanup();

    const fetches = net.calls();
    net.script({ status: 403 });
    renderTodos({ retry: true, retryDelay: 1000 });
    await advance(20_000);
    expect(net.calls()).toBe(fetches + 1);
  });

  test("app-wide: queryConfig.retry and retryDelay apply to every useQuery", async () => {
    net.script({ status: 500 });
    renderTodos(undefined, { retry: 1, retryDelay: 50 });
    await advance(50);
    expect(net.calls()).toBe(2);
    await advance(LATER);
    expect(net.calls()).toBe(2);
  });

  test("app-wide retry: 0 turns retries off; a call site turns them back on", async () => {
    net.script({ status: 500 });
    renderTodos(undefined, { retry: 0 });
    await advance(LATER);
    expect(net.calls()).toBe(1);
    cleanup();

    const fetches = net.calls();
    renderTodos({ retry: 2 }, { retry: 0 });
    await advance(LATER);
    expect(net.calls()).toBe(fetches + 3);
  });

  test("the deprecated retryIntervalOnError is the backoff's base", async () => {
    net.script({ status: 500 });
    renderTodos(undefined, { retryIntervalOnError: 300 });
    await advance(300);
    expect(net.calls()).toBe(2);
    await advance(599);
    expect(net.calls()).toBe(2);
    await advance(1);
    expect(net.calls()).toBe(3);
  });
});

describe("revalidation still works around the policy", () => {
  test("coming back online retries a query that ran out of retries", async () => {
    net.script("network");
    renderTodos();
    await advance(LATER);
    expect(net.calls()).toBe(4);

    net.script({ status: 200, body: [{ id: 1 }] });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await advance(0);
    expect(net.calls()).toBe(5);
  });

  test("coming back online after a failed retry starts a fresh run", async () => {
    net.script("network");
    renderTodos();
    await advance(LATER);
    expect(net.calls()).toBe(4);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await advance(LATER);
    expect(net.calls()).toBe(8);
  });

  test("coming back online does not refetch a 404", async () => {
    net.script({ status: 404 });
    renderTodos();
    await advance(0);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await advance(LATER);
    expect(net.calls()).toBe(1);
  });

  test("revalidateOnFocus refetches a 404 on return, once, without a retry loop", async () => {
    net.script({ status: 404 });
    renderTodos({ revalidateOnFocus: true });
    await advance(10_000);
    expect(net.calls()).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await advance(LATER);
    expect(net.calls()).toBe(2);
  });
});

describe("useUser", () => {
  function UserView(props: { config?: Parameters<typeof useUser>[0] }) {
    const { user, loading, error } = useUser(props.config);
    return (
      <div>{`user:${(user as any)?.id ?? "none"} loading:${loading} error:${(error as any)?.status ?? "none"}`}</div>
    );
  }

  test("an anonymous visitor on a public page makes one /auth/me request, not a poll", async () => {
    net.script({ status: 401, body: "Authentication error" });
    const screen = render(
      <Providers auth={{ user: null }}>
        <UserView />
      </Providers>,
    );
    await advance(0);
    expect(
      screen.queryByText("user:none loading:false error:401"),
    ).not.toBeNull();

    // The issue's 10s loop would have made 30 requests by now.
    await advance(LATER);
    expect(net.urls()).toEqual(["/api/auth/me"]);
    expect(
      screen.queryByText("user:none loading:false error:401"),
    ).not.toBeNull();
  });

  test("a 5xx from /auth/me is retried by default, and useUser({ retry }) overrides it", async () => {
    net.script({ status: 503 });
    render(
      <Providers>
        <UserView />
      </Providers>,
    );
    await advance(LATER);
    expect(net.calls()).toBe(4);
    cleanup();

    const fetches = net.calls();
    render(
      <Providers>
        <UserView config={{ retry: false }} />
      </Providers>,
    );
    await advance(LATER);
    expect(net.calls()).toBe(fetches + 1);
  });

  test("the app's general queryConfig does not reach useUser; queryConfig.user does", async () => {
    net.script({ status: 503 });
    render(
      <Providers queryConfig={{ retry: 0 }}>
        <UserView />
      </Providers>,
    );
    await advance(LATER);
    expect(net.calls()).toBe(4);
    cleanup();

    const fetches = net.calls();
    render(
      <Providers queryConfig={{ retry: 3, user: { retry: 0 } }}>
        <UserView />
      </Providers>,
    );
    await advance(LATER);
    expect(net.calls()).toBe(fetches + 1);
  });

  test("queryConfig.user.staleTime: a session-length window stops per-navigation refetches (folio #1093)", async () => {
    net.script({ status: 200, body: { id: "u1" } });
    function Page() {
      // Stands in for a navigation: the layout's useUser remounts.
      const [key, setKey] = useState(0);
      navigate = () => setKey((k) => k + 1);
      return <UserView key={key} />;
    }
    let navigate = () => {};
    const screen = render(
      <Providers
        auth={{ user: { id: "u1" } }}
        queryConfig={{ user: { staleTime: 30 * 60_000 } }}
      >
        <Page />
      </Providers>,
    );
    expect(
      screen.queryByText("user:u1 loading:false error:none"),
    ).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      await advance(60_000);
      await act(async () => navigate());
    }
    expect(net.calls()).toBe(0);

    // Past the window, the next navigation revalidates once.
    await advance(30 * 60_000);
    await act(async () => navigate());
    await advance(0);
    expect(net.calls()).toBe(1);
  });

  test("without it, the default 5s window refetches on a later navigation", async () => {
    net.script({ status: 200, body: { id: "u1" } });
    let navigate = () => {};
    function Page() {
      const [key, setKey] = useState(0);
      navigate = () => setKey((k) => k + 1);
      return <UserView key={key} />;
    }
    render(
      <Providers auth={{ user: { id: "u1" } }}>
        <Page />
      </Providers>,
    );
    await advance(60_000);
    await act(async () => navigate());
    await advance(0);
    expect(net.calls()).toBe(1);
  });
});

describe("useInfiniteQuery page 1 follows the policy", () => {
  function List(props: { config?: Record<string, unknown> }) {
    const { items, error } = useInfiniteQuery("/items" as any, {}, {
      suspense: false,
      getNextPage: () => null,
      ...props.config,
    } as any);
    return (
      <div>{`items:${(items as unknown[]).length} error:${(error as any)?.status ?? "none"}`}</div>
    );
  }

  test("a 404 on page 1 is not retried", async () => {
    net.script({ status: 404 });
    const screen = render(
      <Providers>
        <List />
      </Providers>,
    );
    await advance(LATER);
    expect(net.calls()).toBe(1);
    expect(screen.queryByText("items:0 error:404")).not.toBeNull();
  });

  test("a 500 on page 1 is retried with the configured policy", async () => {
    net.script({ status: 500 }, { status: 200, body: [1, 2] });
    const screen = render(
      <Providers>
        <List config={{ retry: 1, retryDelay: 25 }} />
      </Providers>,
    );
    await advance(25);
    expect(net.calls()).toBe(2);
    expect(screen.queryByText("items:2 error:none")).not.toBeNull();
  });
});

describe("retryPolicy helpers", () => {
  const err = (status: number, retryAfter?: number) =>
    new QueryError("/x", "", status, null, retryAfter);

  test("isRetryableQueryError", () => {
    for (const status of [400, 401, 403, 404, 409, 410, 422]) {
      expect(isRetryableQueryError(err(status))).toBe(false);
    }
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableQueryError(err(status))).toBe(true);
    }
    expect(isRetryableQueryError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableQueryError(new SyntaxError("bad json"))).toBe(true);
  });

  test("shouldRetryQuery", () => {
    expect(shouldRetryQuery(3, err(500))).toBe(true);
    expect(shouldRetryQuery(4, err(500))).toBe(false);
    expect(shouldRetryQuery(1, err(401))).toBe(false);
    expect(shouldRetryQuery(1, err(500), false)).toBe(false);
    expect(shouldRetryQuery(1, err(500), 0)).toBe(false);
    expect(shouldRetryQuery(100, err(500), true)).toBe(true);
    expect(shouldRetryQuery(1, err(401), () => true)).toBe(true);
  });

  test("retryDelayFor: exponential, capped at 30s, Retry-After wins", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7].map((n) => retryDelayFor(n, err(500), undefined)),
    ).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(retryDelayFor(1, err(429, 12_000), 50)).toBe(12_000);
    expect(retryDelayFor(2, err(500), undefined, 300)).toBe(600);
  });

  test("parseRetryAfter", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
  });
});
