import { HttpRequest } from "./HttpRequest";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Handler<M extends Method, Input, Output> = (input: Input) => Output;
type Handlers = Handler<any, any, any>[];

class ApiRouter {
  routes: Record<string, Handler<any, any, any> | Handlers | typeof ApiRouter> =
    {};

  handleRequest() {}

  get<T, U>(fn: (i: T) => U): Handler<"GET", T, U> {
    return fn;
  }
  post<T, U>(fn: (i: T) => U): Handler<"POST", T, U> {
    return fn;
  }
}

class TestRequest extends HttpRequest<{ id: string }> {
  schema = {
    id: { string: "must be string" },
  };
}

class NestedNestedRouter extends ApiRouter {
  routes = {
    "/qux": this.post((input: { id: string }) => ({
      qux: input.id,
    })),
  };
}

class NestedRouter extends ApiRouter {
  routes = {
    "/nested": this.get(async (req: TestRequest) => {
      const input = await req.input();
      input.get("id");
      return { status: "ok" };
    }),
    "/baz": NestedNestedRouter,
  };
}

class TestRouter extends ApiRouter {
  routes = {
    "/all": NestedRouter,
    "/foo": this.get(async (req: TestRequest) => {
      const input = await req.input();
      input.get("id");
      return { foo: "foo" };
    }),
  };
}

type TrulyNever = never;

type KeyAndValue<K extends PropertyKey, V> = {
  key: K;
  value: V;
};

type _HandleRouter<
  T extends (new () => ApiRouter) | Handler<any, any, any> | Handlers,
  Prefix extends PropertyKey = "",
> = T extends new () => ApiRouter
  ? RouteParserInner<InstanceType<T>, Prefix>
  : never;

type Extract<Key, T, U> = KeyAndValue<
  `${Key & string}`,
  {
    input: T;
    output: U;
  }
>;

type RouteParserInner<
  T extends ApiRouter,
  Prefix extends PropertyKey = "",
  K extends keyof T["routes"] = keyof T["routes"],
> = K extends any
  ? T["routes"][K] extends Handler<infer M, infer TInput, infer TOutput>
    ? Extract<`${M}:${Prefix & string}${K & string}`, TInput, TOutput>
    : // : T["routes"][K] extends Handlers
      //   ? {
      //       [K in keyof Handlers]: Handlers[K] extends Handler<
      //         infer M,
      //         infer TInput,
      //         infer TOutput
      //       >
      //         ? Extract<`${M}:${Prefix & string}${K & string}`, TInput, TOutput>
      //         : never;
      //     }[number]
      _HandleRouter<T["routes"][K], `${Prefix & string}${K & string}`>
  : TrulyNever;

type RouteParser<T extends ApiRouter> = KeyAndValueToObject<
  RouteParserInner<T>
>;

type KeyAndValueToObject<TUnion extends KeyAndValue<any, any>> = {
  [T in TUnion as T["key"]]: T["value"];
};

type ParsedRouter = RouteParser<TestRouter>;

// ParsedRouter expected output:
/*
{
  '/foo': { input: { id: string }, output: { foo: string } },
  '/bar': { input: { active: boolean }, output: { bar: boolean } },
  '/baz/qux': { input: { id: string }, output: { qux: string } },
}
*/

type X<T> = T;

type Ar = X<any>[];

type ARx = [X<"hi">, X<boolean>, X<number>];

type P<T extends Ar> = {
  [K in keyof T]: T[K] extends X<infer U> ? U : never;
};

type Y = P<ARx>;
