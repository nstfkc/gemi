import { RequestBreakerError } from "./Error";
import { formatUnsatisfiedContentRange } from "./range";

export class AuthorizationError extends RequestBreakerError {
  private error: string;
  constructor(error: string = "Not authorized") {
    super(error);
    this.name = "AuthorizationError";
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
 * A signed-in user who is not allowed to do this. Thrown by `Auth.guard()`.
 *
 * 403, not 401: a 401 tells the client to re-authenticate, so a client that
 * sends a 401 to the sign-in page would loop a signed-in user without the role
 * straight back to where they started. A request with no user at all is
 * `AuthenticationError`, which stays 401.
 */
export class InsufficientPermissionsError extends RequestBreakerError {
  /**
   * The status of `payload.api`, which answers API routes and `.json` view
   * navigations alike. Before 0.63 it was 401, and a shipped native client may
   * still branch on that — it cannot be rolled forward in the same deploy as
   * the server. Such an app sets this back to 401 once at boot, and removes the
   * line when its clients handle 403:
   *
   * ```ts
   * InsufficientPermissionsError.apiStatus = 401;
   * ```
   *
   * A full page load answers 403 either way; before 0.63 it fell through to
   * the view dispatcher's 400 default, which no client could have relied on.
   */
  static apiStatus: 401 | 403 = 403;

  private error: string;
  constructor(error: string = "Insufficient permissions") {
    super(error);
    this.name = "InsufficientPermissionsError";
    this.error = error;
    this.payload = {
      api: {
        status: InsufficientPermissionsError.apiStatus,
        data: { error: this.error },
      },
      // Without a status a view request would fall through to the
      // dispatcher's 400 default.
      view: { status: 403 },
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

/**
 * No signed-in user. A 401 to an API client; a view request is sent to
 * `redirectTo` instead — a 302 for a page load, and a `Redirect` directive for
 * a `.json` navigation, so the client router follows it rather than leaving
 * the previous page on screen.
 *
 * `redirectTo` is the whole location, intended-URL parameter included.
 * `AuthenticationMiddleware` and `Auth.user()` build it from the request and
 * the `auth.signInPath` config; code throwing this by hand can pass its own.
 */
export class AuthenticationError extends RequestBreakerError {
  constructor(options: { redirectTo?: string } = {}) {
    super("Authentication error");
    this.name = "AuthenticationError";
    const location = options.redirectTo ?? "/auth/sign-in";
    this.payload = {
      api: {
        status: 401,
        data: { error: "Authentication error" },
      },
      viewData: {
        status: 200,
        data: {},
        directive: { kind: "Redirect", path: location },
      },
      view: {
        status: 302,
        headers: {
          "Cache-Control":
            "private, no-cache, no-store, max-age=0, must-revalidate",
          Location: location,
        },
      },
    };
  }
}
