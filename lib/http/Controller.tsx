import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { Context } from "hono";
import { CookieOptions } from "hono/utils/cookie";

export class Controller {
  cookies: any = [];

  constructor(protected ctx: Context) {}

  protected setCookie(name: string, value: string, options?: CookieOptions) {
    this.cookies.push({ name, value, options });
    setCookie(this.ctx, name, value, options);
  }

  protected deleteCookie(name: string, options?: CookieOptions) {
    deleteCookie(this.ctx, name, options);
  }

  protected getCookie(name: string) {
    return getCookie(this.ctx, name);
  }
}
