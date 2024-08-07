import { RequestBreakerError } from "./Error";

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
