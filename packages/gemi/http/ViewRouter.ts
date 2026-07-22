import type { RemoveGroupPrefix } from "../client/types";
import { Redirect } from "../facades/Redirect";
import type { KeyAndValue, KeyAndValueToObject } from "../internal/type-utils";
import type { Controller } from "./Controller";
import type { HttpRequest } from "./HttpRequest";

type ControllerMethods<T extends new () => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

export type ViewRoutes = Record<
  string,
  | ViewRoute<any, any, any>
  | LayoutRoute<any, any, any, any>
  | RedirectRoute<any, any, any>
  | FileRoute<any, any>
  | (new () => ViewRouter)
>;

type CallbackHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Promise<Output> | Output;

export type ViewHandler<Input, Output, Params> =
  | CallbackHandler<Input, Output, Params>
  | (new () => Controller);

type ParseViewControllerHandler<
  C extends new () => Controller,
  M extends ControllerMethods<C>,
> = InstanceType<C>[M] extends (req: HttpRequest<infer Input, infer Params>) => infer Output
  ? ViewRoute<Input, Output, Params>
  : never;

type ParseFileControllerHandler<
  C extends new () => Controller,
  M extends ControllerMethods<C>,
> = InstanceType<C>[M] extends (req: HttpRequest<infer Input, infer Params>) => any
  ? FileRoute<Input, Params>
  : never;

type ParseLayoutControllerHandler<
  T extends ViewRoutes,
  C extends new () => Controller,
  M extends ControllerMethods<C>,
> = InstanceType<C>[M] extends (req: HttpRequest<infer Input, infer Params>) => infer Output
  ? LayoutRoute<T, Input, Output, Params>
  : never;

type RedirectOutput = {
  destination: string;
  permanent?: boolean;
  status?: number;
};

export class RedirectRoute<Input, Output, Params> {
  kind = "redirect" as const;
  viewPath = "REDIRECT";

  // @internal
  middlewares: string[] = [];
  private handler: (req: HttpRequest<Input, Params>) => Promise<RedirectOutput>;
  constructor(
    handler?:
      | CallbackHandler<Input, RedirectOutput, Params>
      | [new () => Controller, ControllerMethods<any>],
  ) {
    if (!handler) {
      this.handler = (() => ({})) as any;
    } else if (typeof handler === "function") {
      this.handler = handler as any;
    } else {
      const [controller, methodName] = handler;
      const controllerInstance = new controller();
      const controllerHandler = controllerInstance[methodName].bind(controllerInstance);
      this.handler = (_req: HttpRequest<Input, Params>): Promise<RedirectOutput> => {
        return controllerHandler();
      };
    }
  }

  async run(req: HttpRequest<Input, Params>, path: string) {
    const { destination, permanent = false, status = 307 } = await this.handler(req);

    if (!destination) {
      throw new Error(`Redirect destination is required see ${path}`);
    }

    Redirect.to(destination as never, { permanent, status });

    return {};
  }

  middleware(middlewares: string[]) {
    this.middlewares = middlewares;
    return this;
  }
}

export type FileBody = Blob | ReadableStream | ArrayBuffer | ArrayBufferView | string;

export type FileOutput =
  | Blob
  | Response
  | {
      file: FileBody;
      /** File name sent in `Content-Disposition`. Defaults to the blob name, if any. */
      name?: string;
      /** Overrides the mime type. Defaults to the blob type, then `application/octet-stream`. */
      type?: string;
      /** `true` sends `attachment` (download), `false` (default) sends `inline`. */
      download?: boolean;
      status?: number;
      headers?: Record<string, string>;
    };

function contentDisposition(name: string, download: boolean) {
  const kind = download ? "attachment" : "inline";
  // Quoted form for legacy clients, RFC 5987 form for anything non-ascii.
  const fallback = name.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function createFileResponse(output: FileOutput, headers: Headers) {
  if (output instanceof Response) {
    return output;
  }

  const isBlob = output instanceof Blob;
  const body = isBlob ? output : output.file;
  const name = isBlob ? (output as File).name : (output.name ?? (output.file as File)?.name);
  const type = (isBlob ? output.type : (output.type ?? (output.file as Blob)?.type)) || "";
  const download = isBlob ? false : (output.download ?? false);
  const status = isBlob ? 200 : (output.status ?? 200);

  if (!isBlob) {
    for (const [key, value] of Object.entries(output.headers ?? {})) {
      headers.set(key, value);
    }
  }

  // `Bun.file()` is lazy, a missing path only blows up once the stream is read,
  // which is after the response has been committed. Check it up front instead.
  if (body instanceof Blob && "exists" in body && typeof body.exists === "function") {
    const exists = await (body as any).exists();
    if (!exists) {
      return new Response("Not found", { status: 404 });
    }
  }

  headers.set("Content-Type", type || "application/octet-stream");
  if (body instanceof Blob) {
    headers.set("Content-Length", String(body.size));
  }
  if (name) {
    headers.set("Content-Disposition", contentDisposition(name, download));
  }

  return new Response((body instanceof Blob ? body.stream() : body) as BodyInit, {
    status,
    headers,
  });
}

export class FileRoute<Input, Params> {
  kind = "file" as const;
  viewPath = "FILE";

  // @internal
  middlewares: string[] = [];
  private handler: (req: HttpRequest<Input, Params>) => Promise<FileOutput> | FileOutput;
  constructor(
    handler?:
      | CallbackHandler<Input, FileOutput, Params>
      | [new () => Controller, ControllerMethods<any>],
  ) {
    if (!handler) {
      this.handler = (() => null) as any;
    } else if (typeof handler === "function") {
      this.handler = handler as any;
    } else {
      const [controller, methodName] = handler;
      const controllerInstance = new controller();
      const controllerHandler = controllerInstance[methodName].bind(controllerInstance);
      this.handler = (req: HttpRequest<Input, Params>) => controllerHandler(req);
    }
  }

  async run(req: HttpRequest<Input, Params>, path: string) {
    const file = await this.handler(req);

    if (!file) {
      throw new Error(`File route handler must return a file see ${path}`);
    }

    return { FILE: file };
  }

  middleware(middlewares: string[]) {
    this.middlewares = middlewares;
    return this;
  }
}

export class ViewRoute<Input, Output, Params> {
  middlewares: string[] = [];
  private handler: (req: HttpRequest<Input, Params>) => Output;
  constructor(
    public viewPath: string,
    handler?:
      | CallbackHandler<Input, Output, Params>
      | [new () => Controller, ControllerMethods<any>],
  ) {
    if (!handler) {
      this.handler = (() => ({})) as any;
    } else if (typeof handler === "function") {
      this.handler = handler as any;
    } else {
      const [controller, methodName] = handler;
      const controllerInstance = new controller();
      const controllerHandler = controllerInstance[methodName].bind(controllerInstance);
      this.handler = (_req: HttpRequest<Input, Params>): Output => {
        return controllerHandler();
      };
    }
  }

  async run(req: HttpRequest<Input, Params>, path: string) {
    const data = await this.handler(req);

    return {
      [this.viewPath]: {
        ...data,
        breadcrumb: {
          label: (data as any)?.breadcrumb ?? "",
          href: path,
        },
      },
    };
  }

  middleware(middlewares: string[]) {
    this.middlewares = middlewares;
    return this;
  }
}

export class LayoutRoute<T extends ViewRoutes, Input, Output, Params> {
  children: new () => ViewRouter;
  middlewares: string[] = [];
  private handler: (req: HttpRequest<Input, Params>) => Output = (() => ({})) as any;
  constructor(
    public viewPath: string,
    handlerOrRoutes:
      | CallbackHandler<Input, Output, Params>
      | [new () => Controller, ControllerMethods<any>]
      | T,
    routes?: T,
  ) {
    if (typeof handlerOrRoutes === "function") {
      this.handler = handlerOrRoutes as any;
      this.children = class extends ViewRouter {
        routes = routes ?? ({} as T);
      };
    } else if (Array.isArray(handlerOrRoutes)) {
      const [controller, methodName] = handlerOrRoutes;
      const controllerInstance = new controller();
      const controllerHandler = controllerInstance[methodName].bind(controllerInstance);
      this.handler = (req: HttpRequest<Input, Params>): Output => {
        return controllerHandler(req);
      };
      this.children = class extends ViewRouter {
        routes = routes ?? ({} as T);
      };
    } else {
      this.children = class extends ViewRouter {
        routes = handlerOrRoutes as T;
      };
      this.handler = () => ({}) as Output;
    }
  }

  async run(req: HttpRequest<Input, Params>, path: string) {
    const data = await this.handler(req);

    return {
      [this.viewPath]: {
        ...data,
        breadcrumb: {
          label: (data as any)?.breadcrumb ?? "",
          href: path,
        },
      },
    };
  }

  middleware(middlewares: string[]) {
    this.middlewares = middlewares;
    return this;
  }
}

export class ViewRouter {
  middlewares: string[] = [];
  routes: ViewRoutes = {};

  public view<C extends new () => Controller, M extends ControllerMethods<C>>(
    viewPath: string,
    handler?: [C, M],
  ): ParseViewControllerHandler<C, M>;
  public view<Input, Output, Params>(
    viewPath: string,
    handler?: ViewHandler<Input, Output, Params>,
  ): ViewRoute<Input, Output, Params>;
  public view<C extends new () => Controller, M extends ControllerMethods<C>>(
    viewPath: string,
    handler?: [C, M] | ViewHandler<any, any, any>,
  ) {
    return new ViewRoute(viewPath, handler as any);
  }

  public file<C extends new () => Controller, M extends ControllerMethods<C>>(
    handler: [C, M],
  ): ParseFileControllerHandler<C, M>;
  public file<Input, Params>(
    handler: CallbackHandler<Input, FileOutput, Params>,
  ): FileRoute<Input, Params>;
  public file<C extends new () => Controller, M extends ControllerMethods<C>>(
    handler: [C, M] | CallbackHandler<any, FileOutput, any>,
  ) {
    return new FileRoute(handler as any);
  }

  // @ts-expect-error
  public redirect<C extends new () => Controller, M extends ControllerMethods<C>>(
    handler?: [C, M],
  ): ParseViewControllerHandler<C, M>;
  public redirect<Input, Output, Params>(
    handler?: ViewHandler<Input, Output, Params>,
  ): ViewRoute<Input, Output, Params>;
  public redirect<C extends new () => Controller, M extends ControllerMethods<C>>(
    handler?: [C, M] | ViewHandler<any, any, any>,
  ) {
    return new RedirectRoute(handler as any);
  }

  public layout<T extends ViewRoutes>(
    viewPath: string,
    handlerOrRoutes: T,
    routes?: T,
  ): LayoutRoute<T, any, any, any>;
  public layout<
    T extends ViewRoutes,
    C extends new () => Controller,
    M extends ControllerMethods<C>,
  >(viewPath: string, handlerOrRoutes: [C, M], routes?: T): ParseLayoutControllerHandler<T, C, M>;
  public layout<T extends ViewRoutes, Input, Output, Params>(
    viewPath: string,
    handlerOrRoutes: CallbackHandler<Input, Output, Params>,
    routes?: T,
  ): LayoutRoute<T, Input, Output, Params>;
  public layout<
    T extends ViewRoutes,
    C extends new () => Controller,
    M extends ControllerMethods<C>,
  >(viewPath: string, handlerOrRoutes: ViewHandler<any, any, any> | [C, M] | T, routes?: T) {
    return new LayoutRoute(viewPath, handlerOrRoutes as any, routes);
  }
}

type ViewRouteParser<T, Prefix extends PropertyKey = ""> =
  T extends ViewRoute<infer Input, infer Output, infer Params>
    ? KeyAndValue<`view:${Prefix & string}`, ViewHandler<Input, Output, Params>>
    : never;

type LayoutRouteParser<T, Prefix extends PropertyKey = ""> =
  T extends LayoutRoute<infer Routes, infer I, infer O, infer P>
    ? RoutesParser<Routes, Prefix> | KeyAndValue<`layout:${Prefix & string}`, ViewHandler<I, O, P>>
    : never;

type ParsePrefixAndKey<
  P extends PropertyKey,
  K extends PropertyKey,
  U extends string = `${P & string}${K & string}`,
> = U extends "//"
  ? "/"
  : U extends `${infer T1}//${infer T2}`
    ? `${RemoveGroupPrefix<T1>}/${RemoveGroupPrefix<T2>}`
    : U extends `${infer T1}/${infer T2}/`
      ? `${RemoveGroupPrefix<T1>}/${RemoveGroupPrefix<T2>}`
      : RemoveGroupPrefix<U>;

type RouterInstanceParser<
  T extends new () => ViewRouter,
  Prefix extends PropertyKey = "",
> = RoutesParser<InstanceType<T>["routes"], Prefix>;

type RoutesParser<
  T extends ViewRoutes,
  Prefix extends PropertyKey = "",
  K extends keyof T = keyof T,
> = K extends any
  ? T[K] extends new () => ViewRouter
    ? RouterInstanceParser<T[K], ParsePrefixAndKey<Prefix, K>>
    : T[K] extends LayoutRoute<any, any, any, any>
      ? LayoutRouteParser<T[K], ParsePrefixAndKey<Prefix, K>>
      : T[K] extends FileRoute<any, any>
        ? never
        : T[K] extends ViewRoute<any, any, any>
          ? ViewRouteParser<T[K], ParsePrefixAndKey<Prefix, K>>
          : never
  : never;

export type CreateViewRPC<
  T extends ViewRouter,
  Prefix extends PropertyKey = "",
> = KeyAndValueToObject<RoutesParser<T["routes"], Prefix>>;
