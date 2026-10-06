import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { s } from "../../ai/Schema";
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
import { ServiceProvider } from "../../support/ServiceProvider";
import { ApiRouteDispatcher } from "../router/ApiRouteDispatcher";
import {
  DEFAULT_MCP_SCOPE,
  McpCallRefusedError,
  McpRegistry,
  McpToolError,
  type McpCaller,
  type McpRemotePrincipal,
} from "./McpRegistry";

/**
 * The registry as the remote transport drives it (#762): a caller whose
 * credential a resolver verified, dispatched as that credential's user and
 * nothing else, held to the tools its scopes reach.
 *
 * Each call is made from inside a request to `/mcp-stand-in`, as the
 * transport makes it from inside the request to its endpoint, with the
 * principal's user on that request's context.
 */

const ALICE = { id: 1, name: "alice", orgId: "org_alice" };
const BOB = { id: 2, name: "bob", orgId: "org_bob" };

const LIVE = {
  expiresAt: new Date(Date.now() + 365 * 86_400_000),
  absoluteExpiresAt: new Date(Date.now() + 365 * 86_400_000),
};

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    return args.token === "v2.tok-alice"
      ? ({ token: args.token, ...LIVE, user: ALICE } as any)
      : null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new StubUsers()));
  }
}

const handled: { route: string; user: number | null; detail?: unknown }[] = [];
const userOf = (req: HttpRequest<any, any>) => req.ctx().user?.id ?? null;

class UploadRequest extends HttpRequest<{ title: string; file: File }> {
  schema = {
    title: { required: "Title is required" },
    file: { required: "File is required", file: "File must be a file" },
  };
}

class Uploads extends Controller {
  async create(req = new UploadRequest()) {
    const input = await req.input();
    const file = input.get("file");
    const seen = {
      title: input.get("title"),
      name: file.name,
      type: file.type,
      text: await file.text(),
    };
    handled.push({ route: "upload", user: userOf(req), detail: seen });
    return seen;
  }
}

class Api extends ApiRouter {
  routes = {
    "/me": this.get(async () => {
      const req = new HttpRequest<any, any>();
      handled.push({ route: "me", user: userOf(req) });
      return {
        id: userOf(req),
        grant: req.mcpGrant(),
        modelOriginated: req.isModelOriginated(),
        cookie: req.rawRequest.headers.get("cookie"),
        token: req.rawRequest.headers.get("access_token"),
        authorization: req.rawRequest.headers.get("authorization"),
      };
    }).middleware(["auth"]),
    "/:orgId/pages": this.get(async (_: HttpRequest<{}, { orgId: string }>) => {
      const req = new HttpRequest<{}, { orgId: string }>();
      handled.push({ route: "pages", user: userOf(req), detail: req.params });
      return [{ orgId: req.params.orgId }];
    }).middleware(["auth"]),
    "/pages/:id": this.delete(async () => {
      const req = new HttpRequest<any, any>();
      handled.push({ route: "delete-page", user: userOf(req), detail: req.params });
      return { deleted: req.params.id };
    }).middleware(["auth"]),
    "/uploads": this.post(Uploads, "create").middleware(["auth"]),
    "/mcp-stand-in": this.post(async () => {
      const req = new HttpRequest<any, any>();
      return await inside(req);
    }),
  };
}

let inside: (req: HttpRequest<any, any>) => Promise<unknown> = async () => ({});

class Mcp extends McpRouter<CreateRPC<Api>> {
  routes = {
    whoami: this.fromApiRoute("GET", "/me", { description: "Who the user is", tags: ["read"] }),
    "list-pages": this.fromApiRoute("GET", "/:orgId/pages", {
      description: "List the pages",
      params: { orgId: (req) => req.ctx().user.orgId },
      tags: ["read"],
    }),
    "delete-page": this.fromApiRoute("DELETE", "/pages/:id", {
      description: "Delete a page",
      params: { id: "input" },
      requiresApproval: true,
      tags: ["write"],
    }),
    upload: this.fromApiRoute("POST", "/uploads", {
      description: "Upload a file",
      input: s.object({ title: s.string() }),
      files: { file: "input" },
      tags: ["write"],
    }),
    // A bound file reads the run's turn, which a remote caller has none of.
    "upload-attached": this.fromApiRoute("POST", "/uploads", {
      description: "Upload what the user attached",
      input: s.object({ title: s.string() }),
      files: { file: (ctx) => ctx.turn.attachments[0] },
      tags: ["write"],
    }),
  };
}

class ScopedMcp extends Mcp {
  scopes = {
    "site:read": { description: "Read your site", tags: ["read"] },
    "site:write": { description: "Edit your site", tags: ["write"] },
    "pages:delete": { description: "Delete pages", names: ["delete-page"] },
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
      mcp: { router: ScopedMcp },
    },
  };
}

const app = new App({ kernel: AppKernel });

const principal = (overrides: Partial<McpRemotePrincipal> = {}): McpRemotePrincipal => ({
  user: BOB as any,
  via: "oauth",
  id: "grant_1",
  scopes: ["site:read", "site:write", "pages:delete"],
  clientId: "client_1",
  ...overrides,
});

/**
 * Runs `fn` inside a request to the stand-in endpoint, carrying `headers`,
 * with `user` on its context as the transport puts it there.
 */
async function asRemote<T>(
  fn: (caller: McpCaller, registry: McpRegistry) => Promise<T>,
  options: {
    principal?: McpRemotePrincipal;
    headers?: Record<string, string>;
    registry?: () => McpRegistry;
  } = {},
): Promise<T> {
  const p = options.principal ?? principal();
  let out: { ok: true; value: T } | { ok: false; error: unknown } = { ok: false, error: null };
  inside = async (req) => {
    req.ctx().setUser(p.user);
    try {
      out = {
        ok: true,
        value: await fn(
          { kind: "remote", req, principal: p },
          (options.registry ?? (() => resolve(McpRegistry)))(),
        ),
      };
    } catch (error) {
      out = { ok: false, error };
    }
    return {};
  };
  await app.fetch(
    new Request("http://gemi.dev/api/mcp-stand-in", { method: "POST", headers: options.headers }),
  );
  if (out.ok === false) throw out.error;
  return out.value;
}

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name).sort();

beforeEach(() => {
  handled.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listing for a remote caller", () => {
  test("sees the tools its scopes reach, as it can call them", async () => {
    const all = await asRemote(async (caller, registry) => registry.list(caller));
    // `upload-attached` has a bound file: no remote caller can call it.
    expect(names(all)).toEqual(["delete-page", "list-pages", "upload", "whoami"]);

    const read = await asRemote(async (caller, registry) => registry.list(caller), {
      principal: principal({ scopes: ["site:read"] }),
    });
    expect(names(read)).toEqual(["list-pages", "whoami"]);

    const byName = await asRemote(async (caller, registry) => registry.list(caller), {
      principal: principal({ scopes: ["pages:delete"] }),
    });
    expect(names(byName)).toEqual(["delete-page"]);
  });

  test("a credential with no scope, or only unknown ones, sees nothing", async () => {
    for (const scopes of [[], ["admin"], [DEFAULT_MCP_SCOPE]]) {
      const tools = await asRemote(async (caller, registry) => registry.list(caller), {
        principal: principal({ scopes }),
      });
      expect(tools).toEqual([]);
    }
  });

  test("the filter narrows within what the scopes reach, never past it", async () => {
    const tools = await asRemote(
      async (caller, registry) => registry.list(caller, { tags: ["write"] }),
      { principal: principal({ scopes: ["site:read"] }) },
    );
    expect(tools).toEqual([]);
  });

  test("a file field is a file object, not an attachment id", async () => {
    const [upload] = await asRemote(async (caller, registry) =>
      registry.list(caller, { names: ["upload"] }),
    );
    expect(upload.inputSchema.toJSONSchema()).toMatchObject({
      properties: {
        title: { type: "string" },
        file: {
          type: "object",
          properties: {
            name: { type: "string" },
            mimeType: { type: "string" },
            data: { type: "string" },
          },
          required: ["name", "mimeType"],
          additionalProperties: false,
        },
      },
    });
    // No url without fetchUrls.
    expect(
      (upload.inputSchema.toJSONSchema() as any).properties.file.properties,
    ).not.toHaveProperty("url");
    // The local descriptor is unchanged.
    expect(
      (
        resolve(McpRegistry)
          .descriptors({ names: ["upload"] })[0]
          .inputSchema.toJSONSchema() as any
      ).properties.file,
    ).toMatchObject({ type: "string" });
  });

  test("scopes and scopesFor answer what a consent screen and a challenge need", () => {
    const registry = resolve(McpRegistry);
    expect(registry.scopes()).toEqual([
      { name: "site:read", description: "Read your site" },
      { name: "site:write", description: "Edit your site" },
      { name: "pages:delete", description: "Delete pages" },
    ]);
    expect(registry.scopesFor("delete-page")).toEqual(["site:write", "pages:delete"]);
    expect(registry.scopesFor("nope")).toEqual([]);
  });

  test("a router without scopes has one, reaching every tool", async () => {
    const registry = new McpRegistry(new Mcp(), resolve(ApiRouteDispatcher));
    expect(registry.scopes()).toEqual([
      { name: DEFAULT_MCP_SCOPE, description: expect.any(String) },
    ]);
    const tools = await asRemote(async (caller) => registry.list(caller), {
      principal: principal({ scopes: [DEFAULT_MCP_SCOPE] }),
    });
    expect(names(tools)).toEqual(["delete-page", "list-pages", "upload", "whoami"]);
  });
});

describe("calling as a remote caller", () => {
  test("runs as the principal's user, and carries none of the request's credentials", async () => {
    // The request to the endpoint carries Alice's session and a bearer token;
    // the principal is Bob. Only Bob may come out the other end.
    const answer = (await asRemote(
      async (caller, registry) => registry.execute(caller, "whoami", {}),
      {
        headers: {
          Cookie: "access_token=v2.tok-alice",
          access_token: "v2.tok-alice",
          Authorization: "Bearer mcp-token",
        },
      },
    )) as any;

    expect(answer).toEqual({
      id: BOB.id,
      grant: {
        via: "oauth",
        id: "grant_1",
        scopes: ["site:read", "site:write", "pages:delete"],
        clientId: "client_1",
      },
      modelOriginated: true,
      cookie: null,
      token: null,
      authorization: null,
    });
  });

  test("a binder reads the principal's user off the endpoint's request", async () => {
    await asRemote(async (caller, registry) => registry.execute(caller, "list-pages", {}));
    expect(handled).toEqual([{ route: "pages", user: BOB.id, detail: { orgId: BOB.orgId } }]);
  });

  test("a tool the scopes do not reach is refused like one that does not exist", async () => {
    const refusal = (name: string) =>
      asRemote(async (caller, registry) => registry.execute(caller, name, {}), {
        principal: principal({ scopes: ["site:read"] }),
      }).catch((error) => error);

    const hidden = await refusal("upload");
    const missing = await refusal("no-such-tool");
    const bound = await refusal("upload-attached");
    for (const error of [hidden, missing, bound]) {
      expect(error).toBeInstanceOf(McpCallRefusedError);
      expect(error.reason).toBe("unknown-tool");
    }
    expect(hidden.message).toBe('There is no tool named "upload".');
    expect(missing.message).toBe('There is no tool named "no-such-tool".');
    expect(handled).toEqual([]);
  });

  test("requiresApproval fails closed without approval, and runs with it", async () => {
    const refused = await asRemote(async (caller, registry) =>
      registry.execute(caller, "delete-page", { id: "pg_1" }),
    ).catch((error) => error);
    expect(refused).toBeInstanceOf(McpCallRefusedError);
    expect(refused.reason).toBe("approval-required");
    expect(handled).toEqual([]);

    const done = await asRemote(async (caller, registry) =>
      registry.execute(caller, "delete-page", { id: "pg_1" }, undefined, { approved: true }),
    );
    expect(done).toEqual({ deleted: "pg_1" });
    expect(handled).toEqual([{ route: "delete-page", user: BOB.id, detail: { id: "pg_1" } }]);
  });

  test("a principal with no user, or a malformed caller, is refused before anything runs", async () => {
    await expect(
      asRemote(async (caller, registry) => registry.execute(caller, "whoami", {}), {
        principal: principal({ user: undefined as any }),
      }),
    ).rejects.toThrow(/the principal a caller resolver verified/);
    await expect(
      asRemote(async (_caller, registry) => registry.list({ kind: "remote", token: "t" } as any)),
    ).rejects.toThrow(/the principal a caller resolver verified/);
    expect(handled).toEqual([]);
  });

  test("dispatchAs refuses an identity without a user", async () => {
    await expect(
      asRemote(async (caller) =>
        resolve(ApiRouteDispatcher).dispatchAs(caller.req, "GET", "/me", undefined, {
          identity: {} as any,
        }),
      ),
    ).rejects.toThrow(/identity needs the user/);
  });

  test("the route's own middleware still decides", async () => {
    // A user the auth middleware would not accept is not made acceptable by
    // being a principal: here, the route sees exactly the user it was given.
    const answer = (await asRemote(
      async (caller, registry) => registry.execute(caller, "whoami", {}),
      {
        principal: principal({ user: ALICE as any, id: "grant_2" }),
      },
    )) as any;
    expect(answer.id).toBe(ALICE.id);
    expect(answer.grant.id).toBe("grant_2");
  });

  test("a local caller is unchanged: it carries the session, and no grant", async () => {
    inside = async (req) => resolve(McpRegistry).execute({ kind: "local", req }, "whoami", {});
    const res = await app.fetch(
      new Request("http://gemi.dev/api/mcp-stand-in", {
        method: "POST",
        headers: { Cookie: "access_token=v2.tok-alice" },
      }),
    );
    expect(await res.json()).toMatchObject({ id: ALICE.id, grant: null, modelOriginated: true });
  });
});

describe("a remote caller's files", () => {
  const upload = (file: unknown, registry?: () => McpRegistry) =>
    asRemote(async (caller, r) => r.execute(caller, "upload", { title: "Notes", file }), {
      registry,
    });

  test("base64 data is decoded into the multipart field the route reads", async () => {
    const answer = await upload({
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello, world").toString("base64"),
    });
    expect(answer).toEqual({
      title: "Notes",
      name: "notes.txt",
      type: expect.stringMatching(/^text\/plain/),
      text: "hello, world",
    });
    expect(handled[0].user).toBe(BOB.id);
  });

  test("refusals are the model's to read, and nothing is dispatched", async () => {
    const cases: [unknown, RegExp][] = [
      [{ name: "a.txt", mimeType: "text/plain", data: "not base64!" }, /not base64/],
      [{ name: "a.txt", mimeType: "text/plain", data: "abc" }, /not base64/],
      [{ name: "../etc/passwd", mimeType: "text/plain", data: "" }, /needs a name/],
      [{ name: "a\nb", mimeType: "text/plain", data: "" }, /needs a name/],
      [{ name: "a.txt", mimeType: "nonsense", data: "" }, /not a media type/],
      [{ name: "a.txt", mimeType: "text/plain" }, /needs its bytes, base64, in data/],
      [
        { name: "a.txt", mimeType: "text/plain", url: "https://example.com/a.txt" },
        /has no field "url"/,
      ],
      // Without fetchUrls, url is not a field a file has.
      [
        { name: "a.txt", mimeType: "text/plain", data: "", url: "https://example.com" },
        /has no field "url"/,
      ],
      [{ name: "a.txt", data: "" }, /needs "mimeType"/],
      ["gemi_att_1", /must be an object/],
    ];
    for (const [file, message] of cases) {
      const error = await upload(file).catch((e) => e);
      expect(error, JSON.stringify(file)).toBeInstanceOf(McpToolError);
      expect(error.message).toMatch(message);
    }
    expect(handled).toEqual([]);
  });

  test("a file over maxBytes is refused before it is decoded", async () => {
    const small = () =>
      new McpRegistry(new ScopedMcp(), resolve(ApiRouteDispatcher), { files: { maxBytes: 8 } });
    const error = await upload(
      { name: "a.txt", mimeType: "text/plain", data: Buffer.from("123456789").toString("base64") },
      small,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(McpToolError);
    expect(error.message).toMatch(/larger than the 8 bytes/);
    const fits = await upload(
      { name: "a.txt", mimeType: "text/plain", data: Buffer.from("12345678").toString("base64") },
      small,
    );
    expect(fits).toMatchObject({ text: "12345678" });
  });

  test("maxBytes must be a positive whole number", () => {
    expect(
      () =>
        new McpRegistry(new ScopedMcp(), resolve(ApiRouteDispatcher), { files: { maxBytes: 0 } }),
    ).toThrow(/files.maxBytes/);
  });

  describe("by URL, when the app allows it", () => {
    let server: ReturnType<typeof Bun.serve>;
    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        fetch: (req) =>
          new URL(req.url).pathname === "/big"
            ? new Response("x".repeat(100))
            : new Response("fetched bytes", { headers: { "Content-Type": "text/plain" } }),
      });
    });
    afterAll(() => {
      server.stop(true);
    });

    const fetching = (options: Record<string, unknown>) => () =>
      new McpRegistry(new ScopedMcp(), resolve(ApiRouteDispatcher), {
        files: { maxBytes: 50, fetchUrls: options as any },
      });

    test("the schema offers url, and only https is fetched", async () => {
      const [tool] = await asRemote(async (caller, r) => r.list(caller, { names: ["upload"] }), {
        registry: fetching({}),
      });
      expect((tool.inputSchema.toJSONSchema() as any).properties.file.properties).toHaveProperty(
        "url",
      );

      const error = await upload(
        { name: "a.txt", mimeType: "text/plain", url: `http://127.0.0.1:${server.port}/` },
        fetching({ allowPrivate: true, ports: "any" }),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(McpToolError);
      expect(error.message).toMatch(/only be fetched from an https URL/);
    });

    test("a private address is refused by safeFetch", async () => {
      // https to a loopback address: refused before any connection is made.
      const error = await upload(
        { name: "a.txt", mimeType: "text/plain", url: "https://127.0.0.1/secret" },
        fetching({}),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(McpToolError);
      expect(error.message).toMatch(/could not be fetched from 127.0.0.1/);
      expect(handled).toEqual([]);
    });

    test("data and url together are refused", async () => {
      const error = await upload(
        { name: "a.txt", mimeType: "text/plain", data: "", url: "https://example.com/" },
        fetching({}),
      ).catch((e) => e);
      expect(error.message).toMatch(/exactly one of data or url/);
    });
  });
});

describe("refuses at construction", () => {
  const build = (scopes: unknown) =>
    new McpRegistry(Object.assign(new Mcp(), { scopes }) as any, resolve(ApiRouteDispatcher));

  test("a scope naming a tag or tool that does not exist", () => {
    expect(() => build({ a: { description: "x", tags: ["reed"] } })).toThrow(
      /scope "a" names the tag "reed", which no tool has/,
    );
    expect(() => build({ a: { description: "x", names: ["whomai"] } })).toThrow(
      /scope "a" names "whomai", which is no tool/,
    );
  });

  test("a scope that reaches nothing, has no description, or is not a scope token", () => {
    expect(() => build({ a: { description: "x" } })).toThrow(/reaches no tool/);
    expect(() => build({ a: { tags: ["read"] } })).toThrow(/needs a description/);
    expect(() => build({ "a b": { description: "x", tags: ["read"] } })).toThrow(
      /is not a valid OAuth scope/,
    );
    expect(() => build({ 'a"b': { description: "x", tags: ["read"] } })).toThrow(
      /is not a valid OAuth scope/,
    );
  });
});
