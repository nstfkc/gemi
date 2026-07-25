import { RequestBreakerError } from "./Error";
import { formatUnsatisfiedContentRange } from "./range";

export class AuthorizationError extends RequestBreakerError {
  private error: string;
  constructor(error: string = "Not authorized") {
    super("Authentication error");
    this.name = "AuthenticationError";
    this.error = error;
    this.payload = {
      api: {
        status: 401,
        data: { error: this.error },
      },
      view: {},
    };
  }
}

export class InsufficientPermissionsError extends RequestBreakerError {
  private error: string;
  constructor(error: string = "Insufficient permissions") {
    super("Authentication error");
    this.name = "AuthenticationError";
    this.error = error;
    this.payload = {
      api: {
        status: 401,
        data: { error: this.error },
      },
      view: {},
    };
  }
}

/**
 * A `Range` that cannot be satisfied against the object's current size.
 *
 * Extends `RequestBreakerError` so a bare `FileStorage.read()` inside an
 * ordinary route still produces a correct 416 — and, importantly, so it does
 * not trip `onRequestFail`. A 416 is the client's header being wrong about the
 * object, not a server failure.
 */
export class RangeNotSatisfiableError extends RequestBreakerError {
  constructor(public total: number) {
    super("Range not satisfiable");
    this.name = "RangeNotSatisfiableError";
    this.payload = {
      api: {
        status: 416,
        data: { error: { message: "Range not satisfiable" } },
        headers: {
          "Content-Range": formatUnsatisfiedContentRange(total),
          "Accept-Ranges": "bytes",
          // Decided by the client's own Range against the object's current
          // length, so it must never be replayed from a cache to a request
          // that did not ask for that window.
          "Cache-Control": "no-store",
        },
      },
      view: {},
    };
  }
}

export class FileNotFoundError extends RequestBreakerError {
  constructor(public fileName: string) {
    super("File not found");
    this.name = "FileNotFoundError";
    this.payload = {
      api: {
        status: 404,
        data: { error: { message: "Not found" } },
        headers: { "Cache-Control": "no-store" },
      },
      view: {},
    };
  }
}

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
