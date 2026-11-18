import { ApiRouter } from "../../../http/ApiRouter";
import { ResourceController } from "../../../http/Controller";
import type { HttpRequest } from "../../../http/HttpRequest";
import { HttpResponse } from "../../../http/HttpResponse";
import { AgentController } from "../../../ai/AgentController";

// The compiler must read this file without ever executing it.
throw new Error("HTTP extractor executed the app");

class Chat extends AgentController {
  agent = {} as any;
}
class Notes extends ResourceController {
  list(_req: HttpRequest<{ page?: number }>) {
    return [{ id: "1" }];
  }
  show(req: HttpRequest<{}, { id: string }>) {
    return { id: req.params.id };
  }
  store(_req: HttpRequest<{ title: string }>) {
    return { id: "1" };
  }
  update(_req: HttpRequest<{ title?: string }, { id: string }>) {
    return { updated: true };
  }
  delete(_req: HttpRequest<{}, { id: string }>) {
    return HttpResponse.noContent();
  }
}
class Nested extends ApiRouter {
  routes = { "/(private)/ping": this.get(() => ({ alive: true })) };
}
class Base extends ApiRouter {}
export class Api extends Base {
  routes = {
    "/search/:org/:cursor?": this.get(
      (
        _req: HttpRequest<
          {
            query: string;
            limit?: number;
            nullable: string | null;
            both?: string | null;
          },
          { org: string; cursor?: string }
        >,
      ) => [{ id: "1", title: "Hello" }],
    ),
    "/notes": this.post(async (req: HttpRequest<{ title: string; text?: string | null }>) => {
      if ((await req.input()).get("title") === "")
        return HttpResponse.error(410, { kind: "gone", message: "Expired" });
      return HttpResponse.json({ id: "1" }, { status: 201 });
    }),
    "/files/:path*": this.get((_req: HttpRequest<{}, { path: string[] }>) => "ok"),
    "/null": this.get(() => null),
    "/maybe-empty": this.get((_req: HttpRequest<{ empty: boolean }>) => {
      if (Math.random() > 0.5) return HttpResponse.noContent();
      return HttpResponse.json({ id: "1" });
    }),
    "/raw-response": this.get(() => {
      if (Math.random() > 0.5) return new Response("raw");
      return { id: "1" };
    }),
    "/mismatch/:noteId": this.get((_req: HttpRequest<{}, { id: string }>) => "ok"),
    "/notes-list": this.get(() => ({ id: "1" })),
    "/notes/list": this.get(() => ({ id: "2" })),
    "/mixed-tags": this.get(() =>
      Math.random() > 0.5 ? { tag: "saved" as const } : { tag: true as const },
    ),
    "/result": this.get((_req: HttpRequest<{ flag?: false | null; enabled: boolean }>) =>
      Math.random() > 0.5
        ? { ok: true as const, data: "saved" }
        : { ok: false as const, error: "failed" },
    ),
    "/controller": this.get(Notes, "list"),
    "/upload": this.post((_req: HttpRequest<{ file: File }>) => "ok"),
    "/errors": this.get(async (req: HttpRequest<{ conflict: boolean }>) => {
      if ((await req.input()).get("conflict")) return HttpResponse.error(409, { kind: "conflict" });
      return HttpResponse.error(410, { kind: "gone" });
    }),
    "/nested": Nested,
    "/resources/:id": this.resource(Notes),
    "/verbs": {
      get: this.get(() => "ok"),
      patch: this.patch((_req: HttpRequest<{ enabled: boolean }>) => ({
        saved: true,
      })),
    },
    "/chat": this.agent(Chat),
    "/voice": this.voice(Chat),
    "/file": this.file(() => null),
    "/stream": this.stream(() => null),
    "/download": { get: this.file(() => null), post: this.post(() => true) },
    "/void": this.post(async () => {}),
    "/maybe-undefined": this.get((): string | undefined => "ok"),
    "/maybe-void": this.get((): string | void => "ok"),
    "/unsupported": this.get(() => ({
      date: new Date(),
      count: 1n,
      pair: [1, "a"] as [number, string],
    })),
  };
}
export default Api;
export const instance = new Api();
export const notRouter = 42;
export class Empty extends ApiRouter {
  routes = {};
}
