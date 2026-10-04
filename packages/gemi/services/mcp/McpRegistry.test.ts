import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { Agent, type AgentRun } from "../../ai/Agent";
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
import { RequestBreakerError } from "../../http/Error";
import { Middleware } from "../../http/Middleware";
import { HttpRequest } from "../../http/HttpRequest";
import { McpRouter } from "../../http/McpRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { PolicyDeniedError } from "../../orm/errors";
import type { ReadResult } from "../file-storage/drivers/types";
import { ServiceProvider } from "../../support/ServiceProvider";
import { ApiRouteDispatcher } from "../router/ApiRouteDispatcher";
import { createFlatApiRoutes } from "../router/createFlatApiRoutes";
import { McpRegistry, McpToolError, type McpCallContext, type McpCaller } from "./McpRegistry";
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
  "v2.tok-alice": { id: 1, name: "alice", orgId: "org_alice" },
  "v2.tok-bob": { id: 2, name: "bob", orgId: "org_bob" },
};

// Far from both ends, so `getSession` neither expires nor slides it.
const LIVE = {
  expiresAt: new Date(Date.now() + 365 * 86_400_000),
  absoluteExpiresAt: new Date(Date.now() + 365 * 86_400_000),
};

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    const user = SESSIONS[args.token];
    return user ? ({ token: args.token, ...LIVE, user } as any) : null;
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

/** An app's own credential: a visitor who owns a draft before signing up. */
class OwnerMiddleware extends Middleware {
  run() {
    if (this.req.cookies.get("owner") !== "o1") {
      throw new RequestBreakerError("Not yours", { status: 403 });
    }
  }
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
    "/drafts/:id": this.get(async () => {
      const req = new HttpRequest<any, any>();
      handled.push({ route: "draft", user: null, params: req.params });
      return { id: req.params.id, cookie: req.rawRequest.headers.get("cookie") };
    }).middleware(["owner"]),
    // Shaped for a UI: whole records, of which a model needs two fields.
    "/pages": this.get(async () => {
      handled.push({ route: "pages", user: null });
      return pages();
    }),
    "/text": this.get(async () => new Response("plain words", { headers: { "Content-Type": "text/plain" } })),
    "/boom": this.post(async () => {
      throw new Error("connection refused at db.internal:5432");
    }),
    // Returns its failure instead of throwing it, so the dispatcher's catch
    // never sees it and only the registry's reading of the status stands
    // between this body and the model.
    "/flaky": this.post(
      async () => new Response("Error: timeout at db.internal:5432\n    at query", { status: 500 }),
    ),
    "/orders/:id/refund": this.post(async () => {
      throw new PolicyDeniedError("Order", "update");
    }).middleware(["auth"]),
    "/admin/wipe": this.delete(async () => {
      handled.push({ route: "wipe", user: null });
      return { wiped: true };
    }),
    "/agent": this.post(async () => inside(new HttpRequest<any, any>())),
    // Answers before the run has taken a step, as `ApiRouter.agent()` does:
    // every tool call happens inside the response body.
    "/agent/stream": this.post(async () => streamed(new HttpRequest<any, any>())).middleware([
      "auth",
    ]),
  };
}

/**
 * The org of whoever holds the run's token, from the credential: `/agent` is
 * not behind `auth`, so `req.ctx().user` is empty there — an anonymous run has
 * to reach the routes' own 401.
 */
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
    // The binder RFC #499 documents: the user, read from the run's request.
    "my-orders": this.fromApiRoute("GET", "/:orgId/orders", {
      description: "List my organization's orders",
      input: s.object({ status: s.string() }),
      params: { orgId: (req) => req.ctx().user.orgId },
    }),
    "create-product": this.fromApiRoute("POST", "/:orgId/products", {
      description: "Create a product",
      input: s.object({ name: s.string(), price: s.number() }),
      params: { orgId: orgOf },
      files: { image: "input" },
    }),
    // A free-form field on an MCP route. `combineSchemas` casts its result into
    // `Schema<T>` without a definition tree, so this is the path on which
    // `supportsStrict` used to answer `true` and send an empty subschema under
    // `strict: true`.
    "import-layout": this.fromApiRoute("POST", "/:orgId/products", {
      description: "Import a layout document",
      input: s.object({ name: s.string(), layout: s.json().describe("Any JSON") }),
      params: { orgId: orgOf },
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
    "refund-order": this.fromApiRoute("POST", "/orders/:id/refund", {
      description: "Refund an order",
      params: { id: "input" },
    }),
    "read-draft": this.fromApiRoute("GET", "/drafts/:id", {
      description: "Read a draft",
      params: { id: "input" },
    }),
  };
}

/** What `OwnedMcp.credentials` was asked with, per call. */
const credentialCalls: McpCallContext[] = [];
let credentialsFor: (call: McpCallContext) => unknown = ({ req }) => ({
  cookies: { owner: req.cookies.get("owner") },
});

/** The same tools, with the app forwarding its own cookie. */
class OwnedMcp extends Mcp {
  credentials(call: McpCallContext) {
    credentialCalls.push(call);
    return credentialsFor(call) as any;
  }
}

let pageCount = 2;
const pages = () =>
  Array.from({ length: pageCount }, (_, i) => ({
    path: `/p${i}`,
    title: `Page ${i}`,
    html: "<main>…</main>".repeat(20),
    updatedAt: "2026-10-04T00:00:00.000Z",
  }));

/** What `result` was handed, per call. */
const projected: { data: unknown; call: unknown }[] = [];
let projectPages: (data: any) => unknown = (data) =>
  data.map(({ path, title }: any) => ({ path, title }));

class ProjectingMcp extends McpRouter<CreateRPC<Api>> {
  routes = {
    "list-pages": this.fromApiRoute("GET", "/pages", {
      description: "List the pages",
      result: (data, call) => {
        projected.push({ data, call });
        return projectPages(data) as { path: string; title: string }[];
      },
    }),
    "list-pages-by-output": this.fromApiRoute("GET", "/pages", {
      description: "List the pages",
      output: s.array(s.object({ path: s.string(), title: s.string() })),
    }),
    "count-pages": this.fromApiRoute("GET", "/pages", {
      description: "Count the pages",
      result: (data) => ({ count: data.length, first: data[0]?.path ?? null }),
      output: s.object({ count: s.number(), first: s.string().nullable() }),
    }),
    "whoami-projected": this.fromApiRoute("GET", "/me", {
      description: "Who the user is",
      result: () => ({ projected: true }),
    }),
    "read-text": this.fromApiRoute("GET", "/text", {
      description: "Read the text",
      result: (data) => data,
    }),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware, owner: OwnerMiddleware } },
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
let streamed: (req: HttpRequest<any, any>) => Response = () => new Response(null);

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
  options: {
    attachments?: ScopedAttachments;
    turn?: ClientTurn;
    registry?: McpRegistry;
    context?: Record<string, unknown>;
  } = {},
) {
  const provider = fakeProvider([toolCall("c1", name, args), finish()], [finish()]);
  const agent = Agent.create({
    name: "shop",
    provider,
    tools: toAgentTools(options.registry ?? resolve(McpRegistry)),
  });
  let messages: AgentMessage[] = [];
  inside = async () => {
    const result = await agent
      .stream({
        messages: [],
        turn: options.turn ?? { text: "go" },
        attachments: options.attachments ?? null,
        ...(options.context ? { context: options.context as any } : {}),
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

/**
 * `runTool`, through a route that streams the run. With `disconnect`, the
 * client cancels the body before the model has asked for anything, and the
 * run goes on without it, as a run does when a tab is closed.
 */
async function streamTool(
  headers: Record<string, string>,
  name: string,
  args: unknown,
  options: { disconnect?: boolean } = {},
) {
  const provider = fakeProvider([toolCall("c1", name, args), finish()], [finish()]);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const script = provider.stream.bind(provider);
  provider.stream = (params) =>
    (async function* () {
      await gate;
      yield* script(params);
    })();
  const agent = Agent.create({
    name: "shop",
    provider,
    tools: toAgentTools(resolve(McpRegistry)),
  });
  let run!: AgentRun;
  streamed = () => {
    run = agent.stream({ messages: [], turn: { text: "go" }, attachments: null }) as AgentRun;
    return run.toResponse();
  };
  const res = await app.fetch(
    new Request("http://gemi.dev/api/agent/stream", { method: "POST", headers }),
  );
  if (options.disconnect) {
    await res.body!.cancel();
    open();
  } else {
    open();
    await res.text();
  }
  const { messages } = await run.result();
  return (messages as AgentMessage[])
    .flatMap((message) => message.content)
    .find((part: any) => part.type === "tool-result" && part.toolCallId === "c1") as any;
}

const alice = { Cookie: "access_token=v2.tok-alice" };

beforeEach(() => {
  handled.length = 0;
  projected.length = 0;
  pageCount = 2;
  projectPages = (data) => data.map(({ path, title }: any) => ({ path, title }));
  credentialCalls.length = 0;
  credentialsFor = ({ req }) => ({ cookies: { owner: req.cookies.get("owner") } });
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

  /**
   * A job or a script. The run no longer carries a request, and these tools
   * are the one kind that cannot do without one: they act as a user by that
   * user's credentials. Refused with a sentence, not dispatched as nobody.
   */
  test("a run started outside any request is told so, and nothing is dispatched", async () => {
    const agent = Agent.create({
      name: "shop",
      provider: fakeProvider([toolCall("c1", "whoami", {}), finish()], [finish()]),
      tools: toAgentTools(resolve(McpRegistry)),
    });

    const { messages } = await agent.stream({ messages: [], turn: { text: "go" } }).result();
    const result = messages
      .flatMap((message) => message.content)
      .find((part: any) => part.type === "tool-result" && part.toolCallId === "c1") as any;

    expect(result.status).toBe("error");
    expect(result.error.message).toBe(
      '"whoami" calls an api route as the user who started this run, and this run was not started inside a request. Run it from an AgentController, or give this agent tools that do not go through the MCP registry.',
    );
    expect(handled).toEqual([]);
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

  /**
   * The strict flag on an MCP-projected tool.
   *
   * `combineSchemas` merges the app's `input` with the bound-param extras and
   * casts the result into `Schema<T>` — so the projected tool has no definition
   * tree, and `supportsStrict` has to read the emitted schema instead. Before
   * it did, an `s.json()` field here went to the provider as an empty subschema
   * under `strict: true`, which is a 400 on every turn.
   */
  test("a free-form field on an mcp route turns strict off for that tool alone", async () => {
    const { offered } = await runTool(alice, "list-orders", { status: "open" });

    const loose = offered.find((tool) => tool.name === "import-layout")!;
    expect(loose.strict).toBe(false);
    expect(loose.parameters.properties!.layout).toEqual({ description: "Any JSON" });

    // Its neighbours are unaffected — the flag is per tool, read off each one's
    // own schema.
    expect(offered.find((tool) => tool.name === "list-orders")!.strict).toBe(true);
    expect(offered.find((tool) => tool.name === "create-product")!.strict).toBe(true);
  });

  test("an unexposed route is not in the tool list, and cannot be called by name", async () => {
    const { result, offered } = await runTool(alice, "wipe", {});

    expect(offered.map((tool) => tool.name).sort()).toEqual([
      "boom",
      "create-product",
      "create-product-from-upload",
      "flaky",
      "import-layout",
      "list-orders",
      "my-orders",
      "read-draft",
      "refund-order",
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
      '"rename-product" was refused with 400: {"error":{"kind":"validation_error","messages":{"name":["Name must be at least 3 characters"]},"status":400}}',
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
    const { result } = await runTool(alice, "rename-product", {
      id: "archive-all",
      name: "Kettle",
    });

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

  test("a policy denial is a refusal the model can read, without the policy's text", async () => {
    const { result } = await runTool(alice, "refund-order", { id: "o1" });

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"refund-order" was refused with 403: {"error":{"kind":"permission","message":"Forbidden","status":403}}' },
    });
    expect(JSON.stringify(result)).not.toContain("policy");
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

describe("the app's own credentials", () => {
  const owned = () => new McpRegistry(new OwnedMcp(), resolve(ApiRouteDispatcher));
  const visitor = { Cookie: "owner=o1; theme=dark" };

  test("without a credentials hook an app cookie is not forwarded, and the route refuses", async () => {
    const { result } = await runTool(visitor, "read-draft", { id: "d1" });

    expect(result.status).toBe("error");
    expect(result.error.message).toMatch(/^"read-draft" was refused with 403/);
    expect(handled).toEqual([]);
  });

  test("the hook's cookie reaches the route's middleware, and nothing else does", async () => {
    const { result } = await runTool(visitor, "read-draft", { id: "d1" }, { registry: owned() });

    expect(result).toMatchObject({ status: "ok", output: { id: "d1", cookie: "owner=o1" } });
    expect(handled).toEqual([{ route: "draft", user: null, params: { id: "d1" } }]);
  });

  test("the hook is asked per call, with the tool, its input and the run's context", async () => {
    await runTool(visitor, "read-draft", { id: "d1" }, { registry: owned() });

    expect(credentialCalls).toHaveLength(1);
    const [call] = credentialCalls;
    expect(call.caller.kind).toBe("local");
    expect(call.req).toBe(call.caller.req);
    expect(call.req.cookies.get("owner")).toBe("o1");
    expect(call.tool.name).toBe("read-draft");
    expect(call.input).toEqual({ id: "d1" });
    expect(call.ctx?.toolCallId).toBe("c1");
  });

  test("a hook that throws is a server failure, logged, and nothing is dispatched", async () => {
    const failure = new Error("signing key missing");
    credentialsFor = () => {
      throw failure;
    };

    const { result } = await runTool(visitor, "read-draft", { id: "d1" }, { registry: owned() });

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"read-draft" failed on the server.' },
    });
    expect(JSON.stringify(result)).not.toContain("signing key");
    expect(console.error).toHaveBeenCalledWith(
      '[gemi/mcp] Binding the credentials of "read-draft" failed:',
      failure,
    );
    expect(handled).toEqual([]);
  });

  test("a hook cannot swap the user: an access_token of its own fails the call", async () => {
    credentialsFor = () => ({ cookies: { access_token: "v2.tok-bob" } });

    const { result } = await runTool(alice, "whoami", {}, { registry: owned() });

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"whoami" failed on the server.' },
    });
    expect(handled).toEqual([]);
  });

  test("a hook answering nothing dispatches with the access token alone", async () => {
    credentialsFor = () => undefined;

    const { result } = await runTool(alice, "whoami", {}, { registry: owned() });

    expect(result).toMatchObject({ status: "ok", output: { id: 1 } });
  });
});

describe("binders given the call (#756)", () => {
  /** What each binder was handed, per call. */
  const seen: { req: HttpRequest<any, any>; call: McpCallContext }[] = [];
  const fileSeen: { ctx: unknown; call: McpCallContext }[] = [];

  class ContextMcp extends McpRouter<CreateRPC<Api>> {
    routes = {
      // The resource the run is about, from what the server handed the run —
      // not from the url of the route that started it.
      "site-orders": this.fromApiRoute("GET", "/:orgId/orders", {
        description: "List the orders of the site this run is about",
        input: s.object({ status: s.string() }),
        params: {
          orgId: (req, call) => {
            seen.push({ req, call });
            return (call.ctx?.context as { siteId?: string } | undefined)?.siteId ?? "";
          },
        },
      }),
      "create-product-from-upload": this.fromApiRoute("POST", "/:orgId/products", {
        description: "Create a product from the image the user attached",
        input: s.object({ name: s.string(), price: s.number() }),
        params: { orgId: (_req, { ctx }) => (ctx!.context as { siteId: string }).siteId },
        files: {
          image: (ctx, call) => {
            fileSeen.push({ ctx, call });
            return ctx.turn.attachments[0];
          },
        },
      }),
    };
  }
  const registry = () => new McpRegistry(new ContextMcp(), resolve(ApiRouteDispatcher));

  beforeEach(() => {
    seen.length = 0;
    fileSeen.length = 0;
  });

  test("a param binder reads the run's context, and the model has no say", async () => {
    const { result, offered } = await runTool(
      alice,
      "site-orders",
      { status: "open", orgId: "org_bob" },
      { registry: registry(), context: { siteId: "site_9" } },
    );

    expect(result).toMatchObject({ status: "ok", output: { orgId: "site_9", status: "open" } });
    expect(handled).toEqual([{ route: "orders", user: 1, params: { orgId: "site_9" } }]);
    const spec = offered.find((tool) => tool.name === "site-orders")!;
    expect(Object.keys(spec.parameters.properties!)).toEqual(["status"]);
  });

  test("the call carries the caller, the tool, the parsed input and the ToolContext", async () => {
    await runTool(
      alice,
      "site-orders",
      { status: "open" },
      { registry: registry(), context: { siteId: "site_9" } },
    );

    expect(seen).toHaveLength(1);
    const [{ req, call }] = seen;
    // The first argument is unchanged: the run's request.
    expect(req).toBe(call.req);
    expect(call.caller).toEqual({ kind: "local", req });
    expect(call.tool.name).toBe("site-orders");
    expect(call.input).toEqual({ status: "open" });
    expect(call.ctx?.toolCallId).toBe("c1");
    expect(call.ctx?.context).toEqual({ siteId: "site_9" });
  });

  test("a file binder gets the same call as its second argument", async () => {
    const mine = scopeFor("user:1");
    const upload = await mine.put(new File(["photo"], "photo.jpg", { type: "image/jpeg" }));

    const { result } = await runTool(
      alice,
      "create-product-from-upload",
      { name: "Photo", price: 3 },
      {
        registry: registry(),
        attachments: mine,
        context: { siteId: "site_9" },
        turn: {
          text: "make a product of this",
          files: [{ attachmentId: upload.id, name: "photo.jpg", mimeType: "image/jpeg" }],
        },
      },
    );

    expect(result).toMatchObject({
      status: "ok",
      output: { orgId: "site_9", image: { name: "photo.jpg" } },
    });
    expect(fileSeen).toHaveLength(1);
    expect(fileSeen[0].call.ctx).toBe(fileSeen[0].ctx);
    expect(fileSeen[0].call.tool.name).toBe("create-product-from-upload");
    expect(fileSeen[0].call.input).toEqual({ name: "Photo", price: 3 });
  });

  test("called without a tool context, the call has none", async () => {
    const req = new HttpRequest(new Request("http://gemi.dev/api/agent", { headers: alice }));
    const error = await registry()
      .execute({ kind: "local", req }, "site-orders", { status: "open" })
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(seen).toHaveLength(1);
    expect(seen[0].call.ctx).toBeUndefined();
    // No site, so the binder answered "" — a server failure, not the model's.
    expect(error?.message).toBe('"site-orders" failed on the server.');
  });
});

describe("projecting what the route answers (#757)", () => {
  const registry = () => new McpRegistry(new ProjectingMcp(), resolve(ApiRouteDispatcher));
  const run = (name: string, headers: Record<string, string> = {}) =>
    runTool(headers, name, {}, { registry: registry() });

  test("result trims a UI-shaped answer before the model sees it", async () => {
    const { result } = await run("list-pages");

    expect(result).toEqual(
      expect.objectContaining({
        status: "ok",
        output: [
          { path: "/p0", title: "Page 0" },
          { path: "/p1", title: "Page 1" },
        ],
      }),
    );
    expect(JSON.stringify(result)).not.toContain("<main>");
  });

  test("result is handed the parsed answer and the call", async () => {
    await run("list-pages");

    expect(projected).toHaveLength(1);
    const { data, call } = projected[0] as { data: any[]; call: any };
    expect(data[0]).toMatchObject({ path: "/p0", html: expect.any(String) });
    expect(call.tool.name).toBe("list-pages");
    expect(call.input).toEqual({});
    // The whole call, as binders get it.
    expect(call.ctx?.toolCallId).toBe("c1");
    expect(call.caller.kind).toBe("local");
  });

  test("output alone drops every field it does not declare", async () => {
    const { result } = await run("list-pages-by-output");

    expect(result.output).toEqual([
      { path: "/p0", title: "Page 0" },
      { path: "/p1", title: "Page 1" },
    ]);
  });

  test("output checks what result returns", async () => {
    const { result } = await run("count-pages");

    expect(result).toMatchObject({ status: "ok", output: { count: 2, first: "/p0" } });
  });

  test("a large answer is projected first and cut only if it is still too large", async () => {
    pageCount = 2_000;
    const { result } = await run("list-pages");

    // ~3MB from the route; a few dozen KB after the projection, so it is whole.
    expect(Array.isArray(result.output)).toBe(true);
    expect(result.output).toHaveLength(2_000);

    pageCount = 20_000;
    projectPages = (data) => data;
    const { result: big } = await run("list-pages");
    expect(big.output).toMatch(/… \[cut at 100000 of \d+ characters\]$/);
  });

  test("a refusal is not projected: the model reads the route's own words", async () => {
    const { result } = await run("whoami-projected");

    expect(result.status).toBe("error");
    expect(result.error.message).toMatch(/^"whoami-projected" was refused with 401/);
  });

  test("a result that throws is a server failure, logged, without its message", async () => {
    const failure = new Error("cannot read html of undefined");
    projectPages = () => {
      throw failure;
    };

    const { result } = await run("list-pages");

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"list-pages" failed on the server.' },
    });
    expect(JSON.stringify(result)).not.toContain("cannot read");
    expect(console.error).toHaveBeenCalledWith(
      '[gemi/mcp] "list-pages" failed in its result projection:',
      failure,
    );
  });

  test("an answer output refuses is a server failure, logged", async () => {
    projectPages = (data) => data.map(({ path }: any) => ({ path, title: 7 }));
    class Strict extends McpRouter<CreateRPC<Api>> {
      routes = {
        "list-pages": this.fromApiRoute("GET", "/pages", {
          description: "List the pages",
          result: (data) => projectPages(data) as { path: string; title: string }[],
          output: s.array(s.object({ path: s.string(), title: s.string() })),
        }),
      };
    }

    const { result } = await runTool({}, "list-pages", {}, {
      registry: new McpRegistry(new Strict(), resolve(ApiRouteDispatcher)),
    });

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"list-pages" failed on the server.' },
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[gemi\/mcp\] "list-pages" answered what its output schema refuses: /),
    );
  });

  test("a body that is not JSON cannot be projected, and says so in the log", async () => {
    const { result } = await run("read-text");

    expect(result).toMatchObject({
      status: "error",
      error: { message: '"read-text" failed on the server.' },
    });
    expect(console.error).toHaveBeenCalledWith(
      '[gemi/mcp] "read-text" answered text/plain that is not JSON, and its result or output needs JSON.',
    );
  });

  test("output is the descriptor's outputSchema and the agent tool's", () => {
    const projecting = registry();
    const byName = Object.fromEntries(projecting.descriptors().map((tool) => [tool.name, tool]));
    expect(byName["count-pages"].outputSchema?.toJSONSchema()).toMatchObject({
      type: "object",
      properties: { count: { type: "number" } },
    });
    expect(byName["list-pages"].outputSchema).toBeUndefined();

    const tools = Object.fromEntries(toAgentTools(projecting).map((tool) => [tool.name, tool]));
    expect(tools["count-pages"].outputSchema).toBe(byName["count-pages"].outputSchema);
    expect(tools["list-pages"].outputSchema).toBeUndefined();
  });

  test("a tool without result or output answers exactly as before", async () => {
    const { result } = await runTool({}, "list-pages", {}, {
      registry: new McpRegistry(
        Object.assign(new McpRouter(), {
          routes: {
            "list-pages": (new McpRouter() as any).fromApiRoute("GET", "/pages", {
              description: "List the pages",
            }),
          },
        }) as any,
        resolve(ApiRouteDispatcher),
      ),
    });

    expect(result.output[0]).toMatchObject({ path: "/p0", html: expect.any(String) });
  });
});

// --- the registry on its own -------------------------------------------------

describe("a streamed run", () => {
  test("a binder reads the user from req.ctx()", async () => {
    const result = await streamTool(alice, "my-orders", { status: "open" });

    expect(result).toMatchObject({
      status: "ok",
      output: { orgId: "org_alice", status: "open" },
    });
    expect(handled).toEqual([{ route: "orders", user: 1, params: { orgId: "org_alice" } }]);
  });

  test("a binder still reads the user after the client has disconnected", async () => {
    const result = await streamTool(alice, "my-orders", { status: "open" }, { disconnect: true });

    expect(result).toMatchObject({
      status: "ok",
      output: { orgId: "org_alice", status: "open" },
    });
    expect(handled).toEqual([{ route: "orders", user: 1, params: { orgId: "org_alice" } }]);
  });
});

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
    expect(registry().list(caller)).toHaveLength(11);
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

    test("an input field that collides with a bound file", () => {
      expect(() =>
        build({
          create: declare("POST", "/:orgId/products", {
            input: s.object({ name: s.string(), image: s.string() }),
            params: { orgId: "input" },
            files: { image: () => "gemi_att_1" },
          }),
        }),
      ).toThrow(/"image" is both an input field and a param or file/);
    });

    test("a result that is not a function", () => {
      expect(() => build({ me: declare("GET", "/me", { result: { path: true } }) })).toThrow(
        /result must be a function/,
      );
    });

    test("an output that is not a schema", () => {
      expect(() => build({ me: declare("GET", "/me", { output: { type: "object" } }) })).toThrow(
        /output must be a schema, built with s/,
      );
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
