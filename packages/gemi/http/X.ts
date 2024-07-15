type HandlerReturn<Input, Output> = { input: Input; output: Output };

type Handler<T, U> = (i: T) => U;

type Handlers = Array<Handler<any, any>>;

type ParseHandlers<T extends Handlers> = {
  [K in keyof T]: T[K] extends Handler<infer TInput, infer TOutput>
    ? HandlerReturn<TInput, TOutput>
    : never;
}[number];

type XX = ParseHandlers<
  [
    Handler<{ id: string }, { qux: string }>,
    Handler<{ age: number }, { status: boolean }>,
  ]
>;
