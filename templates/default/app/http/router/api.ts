import { ApiRouter, type Handler, HttpRequest } from "gemi/http";

class TestRequest extends HttpRequest<{ id: string }> {
  schema = {
    id: { string: "must be string" },
  };
}

export default class extends ApiRouter {
  routes = {
    "/health-check": this.get(async (req: TestRequest) => {
      const input = await req.input();
      input.get("id");
      return { status: "ok" };
    }),
  };
}

class NestedRouter extends ApiRouter {
  routes = {
    "/nested": this.get(async (req: TestRequest) => {
      const input = await req.input();
      input.get("id");
      return { status: "ok" };
    }),
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
  T extends (new () => ApiRouter) | Handler<any, any>,
  Prefix extends PropertyKey = "",
> = T extends new () => ApiRouter
  ? RouteParserInner<InstanceType<T>, Prefix>
  : never;

type RouteParserInner<
  T extends ApiRouter,
  Prefix extends PropertyKey = "",
  K extends keyof T["routes"] = keyof T["routes"],
> = K extends any
  ? T["routes"][K] extends Handler<infer TInput, infer TOutput>
    ? KeyAndValue<
        `${Prefix & string}${K & string}`,
        {
          input: TInput;
          output: TOutput;
        }
      >
    : _HandleRouter<T["routes"][K], `${Prefix & string}${K & string}`>
  : TrulyNever;

type RouteParser<T extends ApiRouter> = KeyAndValueToObject<
  RouteParserInner<T>
>;

type KeyAndValueToObject<TUnion extends KeyAndValue<any, any>> = {
  [T in TUnion as T["key"]]: T["value"];
};

type Parser<T extends ApiRouter> = {
  [K in keyof T["routes"]]: T["routes"][K] extends Handler<any, any>
    ? true
    : false;
};

type Parsed = Parser<TestRouter>;

type ParsedRouter = RouteParser<TestRouter>;

// ParsedRouter expected output:
/*
{
  '/foo': { input: { id: string }, output: { foo: string } },
  '/bar': { input: { active: boolean }, output: { bar: boolean } },
  '/baz/qux': { input: { id: string }, output: { qux: string } },
}
*/
