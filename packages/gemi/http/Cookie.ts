export interface CreateCookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax";
  path?: string;
  domain?: string;
  partitioned?: boolean;
}

export class Cookie {
  constructor(
    private name: string,
    private value: string,
    private options: CreateCookieOptions = {},
  ) {}

  toString() {
    return [
      `${this.name}=${this.value}`,
      this.options.maxAge ? `Max-Age=${this.options.maxAge}` : "",
      this.options.httpOnly ? "HttpOnly" : "",
      this.options.secure ? "Secure" : "",
      this.options.sameSite
        ? `SameSite=${this.options.sameSite}`
        : "SameSite=Strict",
      this.options.path ? `Path=${this.options.path}` : "Path=/",
      this.options.domain ? `Domain=${this.options.domain}` : "",
      this.options.expires
        ? `Expires=${this.options.expires.toUTCString()}`
        : "",
      this.options.partitioned ? "Partitioned" : "",
    ]
      .filter((i) => i !== "")
      .join("; ");
  }
}
