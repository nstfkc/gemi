import { RequestBreakerError } from "./Error";

type MiddlewareResult = Partial<{
  headers: Record<string, string>;
  cookies: Record<string, string>;
}>;

export type MiddlewareReturnType =
  | void
  | Promise<MiddlewareResult>
  | MiddlewareResult;

export type RouterMiddleware = (req: Request) => MiddlewareReturnType;

export class AuthenticationError extends RequestBreakerError {
  constructor() {
    super("Authentication error");
    this.name = "AuthenticationError";
  }

  payload = {
    api: {
      status: 401,
      data: { error: "Authentication error" },
    },
    view: {
      status: 302,
      headers: {
        "Cache-Control":
          "private, no-cache, no-store, max-age=0, must-revalidate",
        Location: "/auth/sign-in",
      },
    },
  };
}

export class ValidationError extends RequestBreakerError {
  errors: Record<string, string[]> = {};
  constructor(errors: Record<string, string[]>) {
    console.log("ValidationError", { errors });
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
