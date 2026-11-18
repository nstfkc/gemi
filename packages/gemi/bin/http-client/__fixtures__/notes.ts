import { ApiRouter } from "../../../http/ApiRouter";
import type { HttpRequest } from "../../../http/HttpRequest";
import { HttpResponse } from "../../../http/HttpResponse";

export default class NotesApi extends ApiRouter {
  routes = {
    "/notes/:id": this.patch(async (req: HttpRequest<{ title: string }, { id: string }>) => {
      const title = (await req.input()).get("title");
      if (!title) return HttpResponse.error(422, { kind: "empty_title" as const });
      return HttpResponse.json({ id: req.params.id, title });
    }),
  };
}
