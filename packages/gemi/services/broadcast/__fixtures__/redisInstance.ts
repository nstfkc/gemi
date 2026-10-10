// One instance of an app that broadcasts through the redis driver, for
// `RedisBroadcastDriver.e2e.test.ts`, which starts two of them as separate
// processes against one Redis:
//
//   TEST_REDIS_URL=redis://127.0.0.1:6379 SECRET=… bun services/broadcast/__fixtures__/redisInstance.ts
//
// It serves the broadcast socket the way `httpProd` does, plus a few control
// endpoints the test drives it through:
//
//   POST /emit    {channel, params?, event, data?, except?}  Broadcast.to(...).emit(...)
//   POST /revoke  {user} | {channel, params?}                Broadcast.revoke(...)
//   POST /members {member, add}                              `team.:teamId` membership, "userId:teamId"
//
// and prints `ready <port>` once it listens.
import { createElement } from "react";

import { App } from "../../../app/App";
import { createRoot } from "../../../client/createRoot";
import { Broadcast } from "../../../facades/Broadcast";
import { ApiRouter } from "../../../http/ApiRouter";
import { ChannelRouter } from "../../../http/ChannelRouter";
import { Middleware } from "../../../http/Middleware";
import { ViewRouter } from "../../../http/ViewRouter";
import { Kernel } from "../../../kernel";

/** Signs in the user the `x-test-user` header names. */
class TestUser extends Middleware {
  async run() {
    const raw = this.req.headers.get("x-test-user") ?? undefined;
    if (raw) this.req.ctx().setUser({ id: Number(raw) });
  }
}

const members = new Set<string>();

class Channels extends ChannelRouter {
  channels = {
    status: this.public(),
    user: this.private(),
    "team.:teamId": this.private((req, { teamId }) =>
      members.has(`${req.ctx().user?.id}:${teamId}`),
    ),
  };
}

class AppKernel extends Kernel {
  config = {
    middleware: {
      aliases: { "test-user": TestUser },
      global: ["test-user"],
    },
    route: {
      channels: Channels,
      api: { rootRouter: class extends ApiRouter {} },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
    redis: { url: process.env.TEST_REDIS_URL },
    broadcast: {
      driver: "redis" as const,
      redis: { prefix: process.env.TEST_REDIS_PREFIX ?? "gemi:bc:" },
    },
  };
}

const app = new App({ kernel: AppKernel });
await app.waitForBoot();
const sockets = app.sockets()!;

async function control(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json() : {};
  switch (url.pathname) {
    case "/emit": {
      const scope = body.except ? Broadcast.toOthers(body.except) : Broadcast;
      scope.to(body.channel, body.params).emit(body.event, body.data);
      return Response.json({ ok: true });
    }
    case "/revoke":
      Broadcast.revoke(body);
      return Response.json({ ok: true });
    case "/members":
      if (body.add) members.add(body.member);
      else members.delete(body.member);
      return Response.json({ ok: true });
    default:
      return new Response("not found", { status: 404 });
  }
}

const server = Bun.serve<any>({
  port: Number(process.argv[2] ?? 0),
  hostname: "127.0.0.1",
  fetch: (req, server) => (sockets.matches(req) ? sockets.upgrade(req, server) : control(req)),
  websocket: sockets.websocket,
});
await sockets.start(server);
console.log(`ready ${server.port}`);

process.on("SIGTERM", async () => {
  setTimeout(() => process.exit(0), 2_000).unref();
  await sockets.shutdown({ terminateAfterMs: 200 });
  server.stop(true);
  await app.shutdown({ timeoutMs: 1_000 });
  process.exit(0);
});
