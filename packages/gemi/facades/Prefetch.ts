import type { RPC } from "../client/rpc";
import type { UrlParser } from "../client/types";
import type { ApiRouterHandler } from "../http/ApiRouter";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { applyParams } from "../utils/applyParams";
import { omitNullishValues } from "../utils/omitNullishValues";
import { ApiRouterServiceContainer } from "../services/router/ApiRouterServiceContainer";

type GetRPC = {
  [K in keyof RPC as K extends `GET:${infer P}` ? P : never]: RPC[K];
};

type Data<T extends keyof GetRPC> = GetRPC[T] extends ApiRouterHandler<
  any,
  infer Data,
  any
>
  ? Awaited<Data>
  : never;

export class Query {
  private static prepare<T extends keyof GetRPC>(
    path: T,
    ...args: [
      options?: {
        search?: Record<string, string | number | boolean | null>;
        params?: Partial<UrlParser<T>>;
      },
    ]
  ) {
    const defaultOptions = { params: {}, search: {} };
    const [options = {}] = args;
    const { search, params } = { ...defaultOptions, ...options };
    const ctx = RequestContext.getStore();

    if (ctx.req.kind === "api") {
      throw new Error("Query.prefetch() cannot be called from an API request");
    }

    const req = ctx.req.rawRequest;
    const url = new URL(req.url);
    const searchParams = new URLSearchParams(
      omitNullishValues(search as Record<string, string>),
    );
    searchParams.delete("json");
    searchParams.sort();
    const pathnameWithSearchParams = [
      `${applyParams(path, params)}`,
      searchParams.toString(),
    ]
      .filter((s) => s.length > 0)
      .join("?");

    const urlStr = `${url.origin}/${pathnameWithSearchParams}`;
    const newReq = new Request(urlStr, { headers: req.headers });
    const httpRequest = new HttpRequest(newReq, params);
    const store = (data: any) => {
      ctx.prefetchedResources.set(applyParams(path, params), {
        [searchParams.toString()]: data,
      });
    };

    const trigger = () => {
      return RequestContext.run(httpRequest, async () => {
        const data: Data<T> =
          await ApiRouterServiceContainer.use().getRouteData(path);
        store(data);
        return data;
      });
    };

    return {
      instant: trigger,
      prefetch: () => {
        ctx.prefetchPromiseQueue.add(trigger);
      },
    };
  }

  static instant<T extends keyof GetRPC>(
    path: T,
    ...args: [
      options?: {
        search?: Record<string, string | number | boolean | null>;
        params?: Partial<UrlParser<T>>;
      },
    ]
  ) {
    return Query.prepare(path, ...args).instant();
  }

  static prefetch<T extends keyof GetRPC>(
    path: T,
    ...args: [
      options?: {
        search?: Record<string, string | number | boolean | null>;
        params?: Partial<UrlParser<T>>;
      },
    ]
  ) {
    return Query.prepare(path, ...args).prefetch();
  }
}
