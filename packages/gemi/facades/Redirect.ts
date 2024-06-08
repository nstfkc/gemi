import { RequestBreakerError } from "../http/Error";

class RedirectError extends RequestBreakerError {
  constructor(path: string) {
    super("Redirect error");
    this.name = "RedirectError";
    this.payload = {
      api: {
        status: 302,
        data: { error: "Redirect error" },
      },
      view: {
        status: 302,
        headers: {
          "Cache-Control":
            "private, no-cache, no-store, max-age=0, must-revalidate",
          Location: path,
        },
      },
    };
  }
}

export class Redirect {
  static to(path: string) {
    throw new RedirectError(path);
  }
}
