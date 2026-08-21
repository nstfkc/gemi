/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useContext } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { I18nContext } from "../client/I18nContext";

import { Page } from "./Page";
import { Form } from "../client/Mutation";
import { Link } from "../client/Link";
import { Redirect } from "../client/Redirect";
import { useTheme } from "../client/ThemeProvider";
import { useBreadcrumbs } from "../client/useBreadcrumbs";
import { useFeature } from "../client/useFeature";
import { useIsNavigationPending } from "../client/useIsNavigationPending";
import { useLocation } from "../client/useLocation";
import { useNavigationProgress } from "../client/useNavigationProgress";
import { useParams } from "../client/useParams";
import { useQuery } from "../client/useQuery";
import { useSearchParams } from "../client/useSearchParams";
import { useTranslator } from "../client/useTranslator";
import { useUser } from "../client/auth/useUser";

/**
 * The seams a component test needs, asserted through the hooks an application
 * actually calls — every one of these rendered its empty state before
 * `gemi/testing` existed, with no supported way to seed the input behind it
 * (#395).
 */

const Greeting = {
  name: "Test",
  dictionary: {
    greeting: { "en-US": "Hello {{name}}", "tr-TR": "Merhaba {{name}}" },
  },
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Unstubbed, a query that misses the cache reaches the network: the point of
  // seeding is that it does not, so the spy is both a stand-in and an
  // assertion target.
  fetchSpy = vi.fn(async () => new Response("null", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<Page> route state", () => {
  test("seeds the params a view reads", () => {
    function View() {
      const { orgId } = useParams();
      return <div>{`org:${orgId}`}</div>;
    }

    render(
      <Page pathname="/app/:orgId/chat" params={{ orgId: "abc" }}>
        <View />
      </Page>,
    );

    expect(screen.getByText("org:abc")).toBeDefined();
  });

  test("resolves the pathname template against those params", () => {
    function View() {
      const { pathname } = useLocation();
      return <div>{pathname}</div>;
    }

    render(
      <Page pathname="/app/:orgId/chat" params={{ orgId: "abc" }}>
        <View />
      </Page>,
    );

    expect(screen.getByText("/app/abc/chat")).toBeDefined();
  });

  test("accepts search params as a string or an object", () => {
    function View() {
      const searchParams = useSearchParams();
      return <div>{searchParams.get("tab") ?? "none"}</div>;
    }

    const { unmount } = render(
      <Page searchParams="?tab=recent">
        <View />
      </Page>,
    );
    expect(screen.getByText("recent")).toBeDefined();
    unmount();

    render(
      <Page searchParams={{ tab: "archived" }}>
        <View />
      </Page>,
    );
    expect(screen.getByText("archived")).toBeDefined();
  });

  test("a Link marks itself active against the page's own URL", () => {
    render(
      <Page pathname="/app/:orgId/chat" params={{ orgId: "abc" }}>
        <Link href={"/app/:orgId/chat" as never}>Chat</Link>
      </Page>,
    );

    const link = screen.getByText("Chat");
    // `params` came from the page, so the template resolved to the same href.
    expect(link.getAttribute("href")).toBe("/app/abc/chat");
    expect(link.getAttribute("data-active")).toBe("true");
  });

  test("reports a navigation rather than performing one", () => {
    const onNavigate = vi.fn();

    render(
      <Page pathname="/app/abc/chat" onNavigate={onNavigate}>
        <Link href={"/app/abc/settings" as never}>Settings</Link>
      </Page>,
    );

    screen.getByText("Settings").click();

    expect(onNavigate).toHaveBeenCalledWith("/app/abc/settings", "push");
  });

  test("catches a navigation issued from a child's mount effect", () => {
    // `<Redirect>` pushes from its own effect, and React flushes child effects
    // before the parent's — so a listener registered in `<Page>`'s effect
    // would not exist yet, and the auth-guard views that redirect on mount
    // would look like they do nothing.
    const onNavigate = vi.fn();

    render(
      <Page pathname="/app" onNavigate={onNavigate}>
        <Redirect href={"/login" as never} action="replace" />
      </Page>,
    );

    expect(onNavigate).toHaveBeenCalledWith("/login", "replace");
  });

  test("keeps the caller's `supportedLocales` order", () => {
    function View() {
      const { supportedLocales } = useContext(I18nContext);
      return <div>{supportedLocales.join(",")}</div>;
    }

    // A language switcher maps over this list, so the page's own locale must
    // not be hoisted to the front of it.
    render(
      <Page
        locale="de-DE"
        defaultLocale="en-US"
        supportedLocales={["en-US", "tr-TR", "de-DE"]}
      >
        <View />
      </Page>,
    );

    expect(screen.getByText("en-US,tr-TR,de-DE")).toBeDefined();
  });

  test("seeds the theme, and `setTheme` still works from there", () => {
    function View() {
      const { theme, setTheme } = useTheme();
      return (
        <button type="button" onClick={() => setTheme("light")}>
          {theme}
        </button>
      );
    }

    render(
      <Page theme="dark">
        <View />
      </Page>,
    );

    expect(screen.getByText("dark")).toBeDefined();
    fireEvent.click(screen.getByText("dark"));
    expect(screen.getByText("light")).toBeDefined();
  });

  test("the navigation-state hooks read from the page's idle router", () => {
    // Nothing here navigates, so the interesting part is that a view calling
    // these renders at all: they read the router's subjects, which `<Page>`
    // supplies rather than leaving as the empty default context.
    function View() {
      return (
        <div>{`${useIsNavigationPending()}:${useNavigationProgress()}`}</div>
      );
    }

    render(
      <Page>
        <View />
      </Page>,
    );

    expect(screen.getByText("false:100")).toBeDefined();
  });

  test("seeds the breadcrumbs, in order", () => {
    function View() {
      return (
        <div>
          {useBreadcrumbs()
            .map((b) => b.label)
            .join(" > ")}
        </div>
      );
    }

    render(
      <Page
        pathname="/app/abc/chat"
        breadcrumbs={[
          { label: "App", href: "/app" },
          { label: "Chat", href: "/app/abc/chat" },
        ]}
      >
        <View />
      </Page>,
    );

    expect(screen.getByText("App > Chat")).toBeDefined();
  });

  test("seeds features, and anything unseeded reads as off", () => {
    // The warning `useFeature` emits for a key the payload does not carry is
    // correct here — an unseeded key really is absent — and asserting the two
    // reads is the point, so it is silenced rather than left to clutter the run.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function View() {
      return (
        <div>{`${useFeature("new-checkout")}:${useFeature("not-seeded")}`}</div>
      );
    }

    render(
      <Page features={{ "new-checkout": true }}>
        <View />
      </Page>,
    );

    expect(screen.getByText("true:false")).toBeDefined();
    warn.mockRestore();
  });
});

describe("<Page> translations", () => {
  test("resolves a dictionary key instead of echoing it back", () => {
    function View() {
      const t = useTranslator("Test" as never);
      return <div>{t("greeting" as never, { name: "Ada" } as never)}</div>;
    }

    render(
      <Page dictionaries={[Greeting]}>
        <View />
      </Page>,
    );

    expect(screen.getByText("Hello Ada")).toBeDefined();
  });

  test("renders the locale the page was given", () => {
    function View() {
      const t = useTranslator("Test" as never);
      return <div>{t("greeting" as never, { name: "Ada" } as never)}</div>;
    }

    render(
      <Page locale="tr-TR" defaultLocale="en-US" dictionaries={[Greeting]}>
        <View />
      </Page>,
    );

    expect(screen.getByText("Merhaba Ada")).toBeDefined();
  });

  test("`translations` seeds the client's own shape, for the current locale", () => {
    function View() {
      const t = useTranslator("Test" as never);
      return <div>{t("greeting" as never, { name: "Ada" } as never)}</div>;
    }

    // No dictionary object anywhere — this is what the server serializes onto
    // the page, so a test can seed it without importing anything of the app's.
    render(
      <Page translations={{ Test: { greeting: "Hi {{name}}" } }}>
        <View />
      </Page>,
    );

    expect(screen.getByText("Hi Ada")).toBeDefined();
  });

  test("`translations` overrides a key the dictionary also defines", () => {
    function View() {
      const t = useTranslator("Test" as never);
      return <div>{t("greeting" as never, { name: "Ada" } as never)}</div>;
    }

    render(
      <Page
        dictionaries={[Greeting]}
        translations={{ Test: { greeting: "Yo {{name}}" } }}
      >
        <View />
      </Page>,
    );

    expect(screen.getByText("Yo Ada")).toBeDefined();
  });

  test("a non-default locale prefixes the links on the page", () => {
    render(
      <Page locale="tr-TR" defaultLocale="en-US">
        <Link href={"/about" as never}>About</Link>
      </Page>,
    );

    expect(screen.getByText("About").getAttribute("href")).toBe("/tr-TR/about");
  });
});

describe("<Page> query data", () => {
  test("a seeded query renders its data and never fetches", () => {
    function View() {
      const { data } = useQuery("/todos" as never);
      return <div>{`${(data as any as { id: number }[]).length} todos`}</div>;
    }

    render(
      <Page queryData={{ "/todos": [{ id: 1 }, { id: 2 }] }}>
        <View />
      </Page>,
    );

    expect(screen.getByText("2 todos")).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a `:param` in the key resolves against the page's params", () => {
    function View() {
      // No `params` at the call site: `useQuery` applies the route's, so the
      // key the cache is read under is the resolved path.
      const { data } = useQuery("/orgs/:orgId/lists" as never);
      return <div>{(data as any as { title: string }).title}</div>;
    }

    render(
      <Page
        pathname="/orgs/:orgId/lists"
        params={{ orgId: "abc" }}
        queryData={{ "/orgs/:orgId/lists": { title: "Inbox" } }}
      >
        <View />
      </Page>,
    );

    expect(screen.getByText("Inbox")).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a query string in the key seeds that search variant only", () => {
    function View(props: { page: string }) {
      const { data } = useQuery(
        "/lists" as never,
        {
          search: { page: props.page },
        } as never,
      );
      return <div>{(data as any as { label: string }).label}</div>;
    }

    render(
      <Page queryData={{ "/lists?page=2": { label: "second page" } }}>
        <View page="2" />
      </Page>,
    );

    expect(screen.getByText("second page")).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("an unseeded query suspends into the page's fallback", () => {
    function View() {
      useQuery("/unseeded" as never);
      return <div>never rendered</div>;
    }

    render(
      <Page fallback={<div>loading</div>}>
        <View />
      </Page>,
    );

    expect(screen.getByText("loading")).toBeDefined();
    expect(fetchSpy).toHaveBeenCalled();
  });

  test("a key whose `:param` the page cannot fill fails naming the key", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    // `useQuery("/orgs/:orgId/lists", { params: { orgId } })` with `orgId` in
    // component state resolves to a path the page's params know nothing about.
    // Left to `applyParams`, that throws `Missing parameter: orgId` under
    // vitest and silently seeds `/orgs/undefined/lists` under `bun test` —
    // two wrong behaviours for one mistake, neither naming the seed key.
    expect(() =>
      render(
        <Page queryData={{ "/orgs/:orgId/lists": [] }}>
          <div>never rendered</div>
        </Page>,
      ),
    ).toThrow(/queryData key "\/orgs\/:orgId\/lists".*:orgId/s);
  });

  test("the /api-prefix warning fires once per key, not once per render", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ui = (
      <Page queryData={{ "/api/todos": [] }}>
        <div>rendered</div>
      </Page>
    );
    const { rerender } = render(ui);
    rerender(ui);
    rerender(ui);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a throwing view renders `errorFallback` instead of failing the render", () => {
    function View(): never {
      throw new Error("boom");
    }

    render(
      <Page
        errorFallback={({ error }) => <div>{`caught:${error.message}`}</div>}
      >
        <View />
      </Page>,
    );

    expect(screen.getByText("caught:boom")).toBeDefined();
  });

  test("`resetErrorBoundary` clears the stored query error, so a retry recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The retry path a view's real `Error` export offers. Without
    // `onReset={clearErrors}`, resetting re-renders the child, `useQuery`
    // reads the failure still held on the resource and throws it straight
    // back, and the fallback never goes away.
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
    );

    function View() {
      const { data } = useQuery("/todos" as never);
      return <div>{`items:${(data as any as unknown[]).length}`}</div>;
    }

    render(
      <Page
        errorFallback={({ resetErrorBoundary }) => (
          <button type="button" onClick={resetErrorBoundary}>
            Try again
          </button>
        )}
      >
        <View />
      </Page>,
    );

    await waitFor(() => expect(screen.getByText("Try again")).toBeDefined());

    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }),
    );
    screen.getByText("Try again").click();

    await waitFor(() => expect(screen.getByText("items:1")).toBeDefined());
  });
});

describe("<Page> forms", () => {
  test("a submitted Form posts to the endpoint, with the page's params applied", async () => {
    render(
      <Page pathname="/orgs/:orgId/todos" params={{ orgId: "abc" }}>
        <Form action={"/orgs/:orgId/todos" as never} method="post">
          <input name="title" defaultValue="write a test" />
          <button type="submit">Save</button>
        </Form>
      </Page>,
    );

    screen.getByText("Save").click();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const [url, init] = (fetchSpy as any).mock.calls[0];
    expect(url).toBe("/api/orgs/abc/todos");
    expect(init.method).toBe("post");
    expect((init.body as FormData).get("title")).toBe("write a test");
  });
});

describe("<Page> auth", () => {
  test("`useUser` reports the seeded user without a request", () => {
    function View() {
      const { user } = useUser();
      return <div>{user ? `user:${user.id}` : "anonymous"}</div>;
    }

    render(
      <Page user={{ id: 7, name: "Ada" }}>
        <View />
      </Page>,
    );

    expect(screen.getByText("user:7")).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("defaults to an anonymous visitor, and still does not fetch", () => {
    function View() {
      const { user } = useUser();
      return <div>{user ? `user:${user.id}` : "anonymous"}</div>;
    }

    render(
      <Page>
        <View />
      </Page>,
    );

    expect(screen.getByText("anonymous")).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
