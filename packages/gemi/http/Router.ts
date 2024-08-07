import { RequestBreakerError } from "./Error";
import type { HttpRequest } from "./HttpRequest";

type MiddlewareResult = Partial<{
  headers: Record<string, string>;
  cookies: Record<string, string>;
}>;

export type MiddlewareReturnType =
  | void
  | Promise<MiddlewareResult>
  | MiddlewareResult;

export type RouterMiddleware = (
  req: HttpRequest,
  ctx: any,
) => MiddlewareReturnType;

export class ValidationError extends RequestBreakerError {
  errors: Record<string, string[]> = {};
  constructor(errors: Record<string, string[]>) {
    super("Validation error");
    this.name = "ValidationError";
    this.errors = errors;
    this.payload = {
      api: {
        status: 400,
        data: {
          error: {
            kind: "validation_error",
            messages: errors,
          },
        },
        headers: {
          "Content-Type": "application/json",
        },
      },
      view: {
        status: 400,
      },
    };
  }
}
