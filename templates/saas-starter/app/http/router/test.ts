type Handler<Input, Output> = (input: Input) => Output;

class Router {
  routes: Record<string, Handler<any, any> | typeof Router> = {};

  get<T, U>(fn: (i: T) => U): Handler<T, U> {
    return fn;
  }
}

type TrulyNever = never;

class BazRouter extends Router {
  routes = {
    "/qux": (input: { id: string }) => ({
      qux: input.id,
    }),
  };
}

class RootRouter extends Router {
  routes = {
    "/foo": (input: { id: string }) => ({
      foo: input.id,
    }),
    "/bar": (input: { active: boolean }) => ({
      bar: input.active,
    }),
    "/baz": BazRouter,
  };
}

type Parser<T extends Router> = {
  [K in keyof T["routes"]]: T["routes"][K] extends Handler<any, any>
    ? true
    : false;
};

type Parsed = Parser<RootRouter>;
