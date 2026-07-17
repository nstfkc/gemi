export type Instrumentation = (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => Promise<Response>;
