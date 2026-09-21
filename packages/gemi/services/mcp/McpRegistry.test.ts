import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { Agent } from "../../ai/Agent";
import type { ProviderEvent, ProviderToolSpec } from "../../ai/AgentProvider";
import { fakeProvider } from "../../ai/providers/fakeProvider";
import { s } from "../../ai/Schema";
import { MemoryAttachmentStore, ScopedAttachments } from "../../ai/store/Attachments";
import type { AgentMessage, ClientTurn } from "../../ai/types";
import { App } from "../../app/App";
import { AuthManager } from "../../auth/AuthManager";
import { UserProvider } from "../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../auth/types";
import { createRoot } from "../../client/createRoot";
import { app as resolve } from "../../foundation/app";
import { ApiRouter, type CreateRPC } from "../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../http/AuthenticationMiddlware";
import { Controller } from "../../http/Controller";
import { HttpRequest } from "../../http/HttpRequest";
import { McpRouter } from "../../http/McpRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import type { ReadResult } from "../file-storage/drivers/types";
import { ServiceProvider } from "../../support/ServiceProvider";
import { ApiRouteDispatcher } from "../router/ApiRouteDispatcher";
import { createFlatApiRoutes } from "../router/createFlatApiRoutes";
import { McpRegistry, McpToolError, type McpCaller } from "./McpRegistry";
import { toAgentTools } from "./toAgentTools";

/**
 * The registry driven the way an app drives it: an agent run inside a real
 * request to `/agent`, its tools projected from the app's `McpRouter`, each
 * tool call dispatched back into the same `App` as the user who started the
 * run. The fake provider plays the model; everything between its tool call and
 * the route handler is the real code.
 */

// --- the app -----------------------------------------------------------------

const SESSIONS: Record<string, { id: number; name: string; orgId: string }> = {
  "tok-alice": { id: 1, name: "alice", orgId: "org_alice" },
  "tok-bob": { id: 2, name: "bob", orgId: "org_bob" },
};

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    const user = SESSIONS[args.token];
    return user ? ({ token: args.token, user } as any) : null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new StubUsers()));
  }
}

/** What each route handler saw, so a test can say the route did not run. */
const handled: { route: string; user: number | null; body?: unknown; params?: unknown }[] = [];

function userOf(req: HttpRequest<any, any>) {
  return req.ctx().user?.id ?? null;
}

class ProductRequest extends HttpRequest<
  { name: string; price: number; image: File },
  { orgId: string }
> {
  schema = {
    name: { required: "Name is required" },
    image: { required: "Image is required", file: "Image must be a file" },
  };
}

class RenameRequest extends HttpRequest<{ name: string }, { id: string }> {
  schema = {
    name: { required: "Name is required", "min:3": "Name must be at least 3 characters" },
  };
}

class ProductController extends Controller {
  async create(req = new ProductRequest()) {
    const input = await req.input();
    const image = input.get("image");
    const seen = {
      orgId: req.params.orgId,
      name: input.get("name"),
      price: input.get("price"),
      image: { name: image.name, type: image.type, text: await image.text() },
    };
    handled.push({ route: "create", user: userOf(req), body: seen });
    return { id: "p1", ...seen };
  }

  async rename(req = new RenameRequest()) {
    const input = await req.input();
    handled.push({ route: "rename", user: userOf(req), params: req.params });
    return { id: req.params.id, name: input.get("name") };
  }
}

class Api extends ApiRouter {
  routes = {
    "/me": this.get(async () => {
      const req = new HttpRequest<any, any>();
      handled.push({ route: "me", user: userOf(req) });
      return { id: userOf(req), modelOriginated: req.isModelOriginated() };
    }).middleware(["auth"]),
    // A callback handler is called with no arguments; the parameter is there
    // for the route's types, and the request is read back from the context.
    "/:orgId/orders": this.get(async (_: HttpRequest<{ status: string }, { orgId: string }>) => {
      const req = new HttpRequest<{ status: string }, { orgId: string }>();
      handled.push({ route: "orders", user: userOf(req), params: req.params });
      return { orgId: req.params.orgId, status: req.search.get("status") };
    }).middleware(["auth"]),
    "/:orgId/products": this.post(ProductController, "create").middleware(["auth"]),
    // Declared before "/products/:id" and not exposed, so the dispatcher's
    // first match would pick it for an id of "archive-all".
    "/products/archive-all": this.put(async () => {
      handled.push({ route: "archive-all", user: null });
      return { archived: "everything" };
    }),
    "/products/:id": this.put(ProductController, "rename").middleware(["auth"]),
    "/boom": this.post(async () => {
      throw new Error("connection refused at db.internal:5432");
    }),
    // Returns its failure instead of throwing it, so the dispatcher's catch
    // never sees it and only the registry's reading of the status stands
    // between this body and the model.
    "/flaky": this.post(
      async () => new Response("Error: timeout at db.internal:5432\n    at query", { status: 500 }),
    ),
    "/admin/wipe": this.delete(async () => {
      handled.push({ route: "wipe", user: null });
      return { wiped: true };
    }),
    "/agent": this.post(async () => inside(new HttpRequest<any, any>())),
  };
}

/** The org of whoever holds the run's token — resolved from the credential, not from `req.ctx()`. */
const orgOf = (req: HttpRequest<any, any>) => {
  const user = SESSIONS[req.cookies.get("access_token") ?? ""];
  if (!user) throw new Error("no session for this run");
  return user.orgId;
};

class Mcp extends McpRouter<CreateRPC<Api>> {
  routes = {
    whoami: this.fromApiRoute("GET", "/me", { description: "Who the user is" }),
    "list-orders": this.fromApiRoute("GET", "/:orgId/orders", {
      description: "List the organization's orders",
      input: s.object({ status: s.string() }),
      params: { orgId: orgOf },
      tags: ["orders"],
    }),
    "create-product": this.fromApiRoute("POST", "/:orgId/products", {
      description: "Create a product",
      input: s.object({ name: s.string(), price: s.number() }),
      params: { orgId: orgOf },
      files: { image: "input" },
    }),
    "create-product-from-upload": this.fromApiRoute("POST", "/:orgId/products", {
      description: "Create a product from the image the user attached",
      input: s.object({ name: s.string(), price: s.number() }),
      params: { orgId: orgOf },
      files: { image: (ctx) => ctx.turn.attachments[0] },
    }),
    "rename-product": this.fromApiRoute("PUT", "/products/:id", {
      description: "Rename a product",
      input: s.object({ name: s.string() }),
      params: { id: "input" },
      requiresApproval: false,
    }),
    boom: this.fromApiRoute("POST", "/boom", { description: "Always fails" }),
    flaky: this.fromApiRoute("POST", "/flaky", { description: "Always answers 500" }),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware } },
    route: {
      api: { rootRouter: Api },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
      mcp: { router: Mcp },
    },
  };
}

const app = new App({ kernel: AppKernel });

// --- the run -----------------------------------------------------------------

/** A `FileStorage` that is a map. */
class FakeStorage {
  readonly objects = new Map<string, Blob>();
  async put(params: any): Promise<string> {
    this.objects.set(params.name, params.body);
    return params.name;
  }
  async read(params: any): Promise<ReadResult> {
    const blob = this.objects.get(typeof params === "string" ? params : params.name)!;
    return {
      body: blob,
      start: 0,
      end: blob.size - 1,
      total: blob.size,
      partial: false,
      type: blob.type,
      name: params.name,
    };
  }
}

const store = new MemoryAttachmentStore();
const storage = new FakeStorage();
const scopeFor = (key: string) => new ScopedAttachments(store, storage as any, { key });

let inside: (req: HttpRequest<any, any>) => Promise<unknown> = async () => ({});

const toolCall = (toolCallId: string, name: string, args: unknown): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name,
  args: JSON.stringify(args),
});

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

/**
 * One agent run, started by a request to `/agent` with `headers`, in which the
 * model calls `name` with `args` once. Answers the tool's result part and what
 * the provider was offered.
 */
async function runTool(
  headers: Record<string, string>,
  name: string,
  args: unknown,
  options: { attachments?: ScopedAttachments; turn?: ClientTurn } = {},
) {
  const provider = fakeProvider([toolCall("c1", name, args), finish()], [finish()]);
  const agent = Agent.create({
    name: "shop",
    provider,
    tools: toAgentTools(resolve(McpRegistry)),
  });
  let messages: AgentMessage[] = [];
  inside = async (req) => {
    const result = await agent
      .stream({
        messages: [],
        req,
        turn: options.turn ?? { text: "go" },
        attachments: options.attachments ?? null,
      })
      .result();
    messages = result.messages as AgentMessage[];
    return {};
  };
  await app.fetch(new Request("http://gemi.dev/api/agent", { method: "POST", headers }));
  const result = messages
    .flatMap((message) => message.content)
    .find((part: any) => part.type === "tool-result" && part.toolCallId === "c1") as any;
  return { result, offered: provider.calls[0]?.tools as ProviderToolSpec[] };
}

const alice = { Cookie: "access_token=tok-alice" };

beforeEach(() => {
  handled.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an agent calling the app's routes", () => {
  test("runs an exposed route as the user who started the run", async () => {
    const { result } = await runTool(alice, "whoami", {});

    expect(result).toMatchObject({ status: "ok", output: { id: 1, modelOriginated: true } });
    expect(handled).toEqual([{ route: "me", user: 1 }]);
  });

  test("an auth-guarded route rejects an anonymous run, and the handler never runs", async () => {
    const { result } = await runTool({}, "whoami", {});

    expect(result.status).toBe("error");
    expect(result.error.message).toMatch(/^"whoami" was refused with 401/);
    expect(handled).toEqual([]);
  });

  test("a bound orgId is the run's, whatever the model sends", async () => {
    const { result, offered } = await runTool(alice, "list-orders", {
      status: "open",
      orgId: "org_bob",
    });

    expect(result).toMatchObject({
      status: "ok",
      output: { orgId: "org_alice", status: "open" },
    });
    expect(handled).toEqual([{ route: "orders", user: 1, params: { orgId: "org_alice" } }]);
    // The model is not even offered the field.
    const spec = offered.find((tool) => tool.name === "list-orders")!;
    expect(Object.keys(spec.parameters.properties!)).toEqual(["status"]);
  });

  test("an unexposed route is not in the tool list, and cannot be called by name", async () => {
    const { result, offered } = await runTool(alice, "wipe", {});

    expect(offered.map((tool) => tool.name).sort()).toEqual([
      "boom",
      "create-product",
      "create-product-from-upload",
      "flaky",
      "list-orders",
      "rename-product",
      "whoami",
    ]);
    expect(result).toMatchObject({
      status: "error",
      error: { message: 'There is no tool named "wipe".' },
    });
    expect(handled).toEqual([]);
  });

  test("an input file field forwards the uploaded bytes to a multipart route", async () => {
    const mine = scopeFor("user:1");
    const upload = await mine.put(new File(["png-bytes"], "mug.png", { type: "image/png" }));

    const { result, offered } = await runTool(
      alice,
      "create-product",
      { name: "Mug", price: 12, image: upload.id },
      { attachments: mine },
    );

    expect(result).toMatchObject({
      status: "ok",
      output: {
        orgId: "org_alice",
        name: "Mug",
        // A form carries strings; the route reads what a browser form would send.
        price: "12",
        image: { name: "mug.png", type: "image/png", text: "png-bytes" },
      },
    });
    const spec = offered.find((tool) => tool.name === "create-product")!;
    expect(spec.parameters.required).toEqual(["name", "price", "image"]);
    expect(spec.parameters.properties!.image).toMatchObject({ type: "string" });
  });

  test("another user's attachment id is a not-found, and nothing is dispatched", async () => {
    const theirs = await scopeFor("user:2").put(
      new File(["secret"], "b.png", { type: "image/png" }),
    );

    const { result } = await runTool(
      alice,
      "create-product",
      { name: "Mug", price: 12, image: theirs.id },
      { attachments: scopeFor("user:1") },
    );

    expect(result).toMatchObject({
      status: "error",
      error: { message: `No attachment ${theirs.id}.` },
    });
    expect(handled).toEqual([]);
  });

  test("a bound file field sends the file of the turn, and the model names nothing", async () => {
    const mine = scopeFor("user:1");
    const upload = await mine.put(new File(["photo"], "photo.jpg", { type: "image/jpeg" }));

    const { result, offered } = await runTool(
      alice,
      "create-product-from-upload",
      { name: "Photo", price: 3, image: "gemi_att_not_this_one" },
      {
        attachments: mine,
        turn: {
          text: "make a product of this",
          files: [{ attachmentId: upload.id, name: "photo.jpg", mimeType: "image/jpeg" }],
        },
      },
    );

    expect(result).toMatchObject({
      status: "ok",
      output: { image: { name: "photo.jpg", text: "photo" } },
    });
    const spec = offered.find((tool) => tool.name === "create-product-from-upload")!;
    expect(Object.keys(spec.parameters.properties!)).toEqual(["name", "price"]);
  });

  test("a bound file field with no file in the turn tells the model so", async () => {
    const { result } = await runTool(
      alice,
      "create-product-from-upload",
      { name: "Photo", price: 3 },
      { attachments: scopeFor("user:1") },
    );

    expect(result.status).toBe("error");
    expect(result.error.message).toMatch(/needs a file for "image", and this turn has none/);
    expect(handled).toEqual([]);
  });

  test("a validation error reaches the model verbatim", async () => {
    const { result } = await runTool(alice, "rename-product", { id: "p1", name: "ab" });

    expect(result.status).toBe("error");
    expect(result.error.message).toBe(
      '"rename-product" was refused with 400: {"error":{"kind":"validation_error","messages":{"name":["Name must be at least 3 characters"]}}}',
    );
  });

  test("an input path param is encoded into one segment", async () => {
    const { result } = await runTool(alice, "rename-product", { id: "a/b c", name: "Kettle" });

    expect(result).toMatchObject({ status: "ok", output: { id: "a%2Fb%20c", name: "Kettle" } });
    expect(handled).toEqual([{ route: "rename", user: 1, params: { id: "a%2Fb%20c" } }]);
  });

  test("a dot segment from the model is refused rather than walked", async () => {
    const { result } = await runTool(alice, "rename-product", { id: "..", name: "Kettle" });

    expect(result).toMatchObject({
      status: "error",
      error: { message: '".." is not a valid value for "id" of "rename-product".' },
    });
    expect(handled).toEqual([]);
  });

  test("an input param that another route matches first is a not-found, and nothing runs", async () => {
    const { result } = await runTool(alice, "rename-product", { id: "archive-all", name: "Kettle" });

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"rename-product" has nothing at /products/archive-all.' },
    });
    expect(handled).toEqual([]);
  });

  test("a route that throws is reported without its message", async () => {
    const { result } = await runTool(alice, "boom", {});

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"boom" failed on the server.' },
    });
    expect(JSON.stringify(result)).not.toContain("db.internal");
  });

  test("a 5xx response is reported without its body", async () => {
    const { result } = await runTool(alice, "flaky", {});

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"flaky" failed on the server.' },
    });
    expect(JSON.stringify(result)).not.toContain("db.internal");
  });
});

// --- the registry on its own -------------------------------------------------

describe("McpRegistry", () => {
  const registry = () => resolve(McpRegistry);

  test("describes each tool by its routes key, with annotations from the verb", () => {
    const byName = Object.fromEntries(
      registry()
        .descriptors()
        .map((tool) => [tool.name, tool]),
    );

    expect(byName.whoami.annotations).toEqual({ readOnlyHint: true });
    expect(byName["create-product"].annotations).toEqual({});
    expect(byName["rename-product"].annotations).toEqual({ idempotentHint: true });
    expect(byName["create-product"]).toMatchObject({
      method: "POST",
      url: "/:orgId/products",
      source: { controller: ProductController, methodName: "create" },
    });
    expect(byName.whoami.source).toBeUndefined();
  });

  test("a DELETE is annotated destructive", () => {
    class Wipe extends McpRouter<CreateRPC<Api>> {
      routes = { wipe: this.fromApiRoute("DELETE", "/admin/wipe", { description: "Wipe" }) };
    }
    const wipe = new McpRegistry(new Wipe(), resolve(ApiRouteDispatcher));

    expect(wipe.descriptors()[0].annotations).toEqual({ destructiveHint: true });
  });

  test("the tool schema is the input plus the input params, in strict form", () => {
    const tool = registry().descriptors({ names: ["rename-product"] })[0];

    expect(tool.inputSchema.toJSONSchema()).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        id: { type: "string", description: 'The ":id" segment of the url.' },
      },
      required: ["name", "id"],
      additionalProperties: false,
    });
  });

  test("list and descriptors take a filter", () => {
    const caller: McpCaller = { kind: "local", req: new HttpRequest(new Request("http://x")) };

    expect(
      registry()
        .list(caller, { tags: ["orders"] })
        .map((tool) => tool.name),
    ).toEqual(["list-orders"]);
    expect(
      registry()
        .list(caller, { names: ["whoami", "boom"] })
        .map((tool) => tool.name),
    ).toEqual(["whoami", "boom"]);
    expect(registry().list(caller)).toHaveLength(7);
  });

  test("a remote caller is typed and refused", async () => {
    const remote: McpCaller = { kind: "remote", token: "t" };

    expect(() => registry().list(remote)).toThrow(/only local callers are implemented/);
    await expect(registry().execute(remote, "whoami", {})).rejects.toThrow(
      /only local callers are implemented/,
    );
  });

  test("dispatches through dispatchAs and never through a flat entry's exec", async () => {
    const flatRoutes = createFlatApiRoutes({ "/": Api });
    const exec = vi.fn();
    for (const methods of Object.values(flatRoutes)) {
      for (const entry of Object.values(methods)) entry.exec = exec;
    }
    const dispatchAs = vi.fn(async () => Response.json({ ok: true }));
    const isolated = new McpRegistry(new Mcp(), {
      flatRoutes,
      dispatchAs,
      getRouteHandlerAndParams: ApiRouteDispatcher.prototype.getRouteHandlerAndParams,
    } as any);
    const req = new HttpRequest(new Request("http://gemi.dev/api/agent", { headers: alice }));

    await isolated.execute({ kind: "local", req }, "list-orders", { status: "open" });
    await isolated.execute({ kind: "local", req }, "rename-product", { id: "p1", name: "Kettle" });

    expect(exec).not.toHaveBeenCalled();
    expect(dispatchAs.mock.calls).toEqual([
      [req, "GET", "/org_alice/orders?status=open", undefined],
      [req, "PUT", "/products/p1", { name: "Kettle" }],
    ]);
  });

  describe("reading what the route answered", () => {
    /** `whoami`, with the dispatcher answering `response` or throwing `error`. */
    const call = (answer: () => Promise<Response>) => {
      const isolated = new McpRegistry(new Mcp(), {
        flatRoutes: createFlatApiRoutes({ "/": Api }),
        dispatchAs: answer,
        getRouteHandlerAndParams: ApiRouteDispatcher.prototype.getRouteHandlerAndParams,
      } as any);
      const req = new HttpRequest(new Request("http://gemi.dev/api/agent", { headers: alice }));
      return isolated.execute({ kind: "local", req }, "whoami", {}).then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );
    };

    test("a success too large for the context window is cut, and says so", async () => {
      const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `row ${i}` }));
      const { value } = (await call(async () => Response.json(rows))) as { value: string };

      expect(typeof value).toBe("string");
      expect(value.length).toBeLessThan(100_100);
      expect(value).toMatch(/… \[cut at 100000 of \d+ characters\]$/);
    });

    test("a file the route serves is described, not shown", async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
      const { value } = await call(
        async () => new Response(png, { headers: { "Content-Type": "image/png" } }),
      );

      expect(value).toBe('"whoami" answered with 8 bytes of image/png, which is not shown.');
    });

    test("a redirect is a server failure, logged for the app", async () => {
      const { error } = (await call(
        async () => new Response(null, { status: 302, headers: { Location: "/login" } }),
      )) as { error: Error };

      expect(error).toBeInstanceOf(McpToolError);
      expect(error.message).toBe('"whoami" failed on the server.');
      expect(console.error).toHaveBeenCalledWith(
        '[gemi/mcp] "whoami" answered 302 to /login, which a tool call cannot follow.',
      );
    });

    test("a path dispatchAs refuses is a server failure, logged for the app", async () => {
      const refusal = new Error('dispatchAs: "/x" is not an app api path.');
      const { error } = (await call(async () => {
        throw refusal;
      })) as { error: Error };

      expect(error.message).toBe('"whoami" failed on the server.');
      expect(console.error).toHaveBeenCalledWith(
        '[gemi/mcp] Dispatching "whoami" failed:',
        refusal,
      );
    });
  });

  test("an argument the schema refuses is a tool error the model can read", async () => {
    const req = new HttpRequest(new Request("http://gemi.dev/api/agent"));
    const error = await registry()
      .execute({ kind: "local", req }, "rename-product", { id: "p1", name: 7 })
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(error).toBeInstanceOf(McpToolError);
    expect(error.message).toBe(
      'Invalid arguments for "rename-product": name: expected string, got number',
    );
  });

  describe("refuses at construction", () => {
    const dispatcher = () => resolve(ApiRouteDispatcher);
    const build = (routes: Record<string, unknown>) =>
      new McpRegistry(Object.assign(new McpRouter(), { routes }) as any, dispatcher());
    const declare = (method: string, url: string, meta: Record<string, unknown>) =>
      (new McpRouter() as any).fromApiRoute(method, url, { description: "x", ...meta });

    test("a route the app does not have", () => {
      expect(() =>
        build({ gone: declare("POST", "/:orgId/prodcuts", { params: { orgId: "input" } }) }),
      ).toThrow(/"gone" \(POST \/:orgId\/prodcuts\) names no route of this app/);
    });

    test("a verb the route does not have", () => {
      expect(() => build({ gone: declare("DELETE", "/me", {}) })).toThrow(/names no route/);
    });

    test("a tool name a model could not be given", () => {
      expect(() => build({ "/me": declare("GET", "/me", {}) })).toThrow(
        /"\/me" is not a valid tool name/,
      );
    });

    test("a path param nobody decided about", () => {
      expect(() => build({ orders: declare("GET", "/:orgId/orders", {}) })).toThrow(
        /the path param "orgId" must be bound or declared "input"/,
      );
    });

    test("a binder that is neither a function nor input", () => {
      expect(() =>
        build({ orders: declare("GET", "/:orgId/orders", { params: { orgId: undefined } }) }),
      ).toThrow(/params.orgId must be a function or "input"/);
    });

    test("an input field that collides with an input param", () => {
      expect(() =>
        build({
          rename: declare("PUT", "/products/:id", {
            input: s.object({ id: s.string() }),
            params: { id: "input" },
          }),
        }),
      ).toThrow(/"id" is both an input field and a param or file/);
    });

    test("an input that is not an object", () => {
      expect(() =>
        build({
          rename: declare("PUT", "/products/:id", { input: s.string(), params: { id: "input" } }),
        }),
      ).toThrow(/input must be an s.object/);
    });
  });
});
