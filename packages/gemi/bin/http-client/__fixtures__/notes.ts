import { ApiRouter } from "../../../http/ApiRouter";
import type { HttpRequest } from "../../../http/HttpRequest";
import { HttpResponse } from "../../../http/HttpResponse";

export default class NotesApi extends ApiRouter {
  routes = {
    "/notes": this.post(
      async (
        req: HttpRequest<{
          note: string | null;
          title?: string;
          "wire-version": 2.5;
          wireVersion?: true | null;
          state?: "open" | "closed";
        }>,
      ) => {
        const input = await req.input();
        const title = input.get("title");
        if (title === "") return HttpResponse.error(422, { kind: "empty_title" });
        if (input.get("state") === "closed") return HttpResponse.error(410, { kind: "gone" });
        const tag: "saved" | null = title ? "saved" : null;
        return title
          ? { ok: true as const, tag, createdAt: new Date() }
          : { ok: false as const, tag };
      },
    ),
    "/notes/:id": this.patch(async (req: HttpRequest<{ title: string }, { id: string }>) => {
      const title = (await req.input()).get("title");
      if (!title) return HttpResponse.error(422, { kind: "empty_title" as const });
      return HttpResponse.json({ id: req.params.id, title });
    }),
  };
}
