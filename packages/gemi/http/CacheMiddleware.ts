import { Middleware } from "./Middleware";

export class CacheMiddleware extends Middleware {
  async run(...args: [scope: string, maxAge: string, ...rest: string[]]) {
    const [scope = "public", maxAge = "864000", ...rest] = args;
    let value = `${scope}, max-age=${maxAge}${rest.length > 0 ? ", " : ""}${rest.join(", ")}`;
    if (args.length === 0) {
      value =
        "public, max-age=864000, stale-while-revalidate=300, stale-if-error=600";
    }
    if (args.length === 1 && args[0] === "public") {
      value =
        "public, max-age=864000, stale-while-revalidate=300, stale-if-error=600";
    }
    if (args.length === 1 && args[0] === "private") {
      value =
        "private, max-age=0, stale-while-revalidate=300, stale-if-error=600";
    }
    if (this.req.rawRequest.method === "GET") {
      this.req.ctx().setHeaders("Cache-Control", value);
    }

    return {};
  }
}
