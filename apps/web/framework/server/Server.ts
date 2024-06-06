import { URLPattern } from "urlpattern-polyfill";

type RequestHandler = (
  req: Request,
  next: () => Response | Promise<Response>,
) => Response | Promise<Response>;

export class Server {
  requestHandlers = new Map<string, RequestHandler>();

  public use(pattern: string, ...requestHandlers: RequestHandler[]) {
    const requestHandler = requestHandlers.reverse().reduce(
      (acc, handler) => {
        return (req: Request) =>
          handler(req, () => acc(req, () => new Response("404")));
      },
      () => new Response("404", { status: 404 }),
    );
    this.requestHandlers.set(pattern, requestHandler);
  }

  public fetch(req: Request) {
    const { pathname } = new URL(req.url);
    const handlerCandidates: [string, RequestHandler][] = [];

    for (const [p, rh] of this.requestHandlers.entries()) {
      const pattern = new URLPattern({ pathname: p });
      if (pattern.test({ pathname })) {
        handlerCandidates.push([p, rh]);
      }
    }
    const [, handler] = handlerCandidates.sort(
      ([pa], [pb]) => pb.length - pa.length,
    )[0];

    if (handler) {
      return handler(req, () => new Response("404"));
    } else {
      return new Response("404 not found", { status: 404 });
    }
  }
}
