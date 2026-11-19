/**
 * A route's own CORS answer (#913): which origins may call it from a browser,
 * with which request headers, and whether cookies count. Declared per route
 * with `.cors(policy)` or per router with `cors = policy`; never app-wide.
 *
 * ```ts
 * class WidgetApiRouter extends ApiRouter {
 *   cors = { origins: "*", headers: ["content-type", "authorization"] };
 *   routes = { "/messages": this.post(WidgetController, "send") };
 * }
 * ```
 *
 * With a policy, gemi answers the route's preflight (`OPTIONS` with
 * `Access-Control-Request-Method`) itself, before any middleware runs, and
 * puts the CORS headers on every response the route sends: the handler's, a
 * middleware's refusal (401, 413, 429) and a policy denial. A 500 from an
 * uncaught error is rendered by the server and has none.
 *
 * `Origin: null` is what a sandboxed frame, a `file:` page or a redirect
 * across origins sends. `origins: "*"` admits it, and so does `"null"` in a
 * list. Credentials are never allowed for it: any site can make a request
 * whose origin is `null`, so a cookie-bearing answer to `null` is an answer
 * to everyone. A widget in such a frame authenticates with a token it sends
 * in a header or the body, never with cookies.
 */
export type CorsPolicy = {
  /**
   * `"*"` for any origin, `null` included, answered as
   * `Access-Control-Allow-Origin: *`. Or exact origins, one or a list
   * (`"https://shop.example"`, scheme, host and port, no path), each echoed
   * back with `Vary: Origin`; `"null"` admits opaque origins.
   *
   * Typed `string` rather than `"*"` so a router's `cors = { origins: "*" }`
   * typechecks without an annotation; any other string must be an origin.
   */
  origins: string | readonly string[];
  /**
   * The methods a preflight allows. Default: every method the path answers
   * under this policy.
   */
  methods?: readonly string[];
  /**
   * The request headers a preflight allows, beyond the CORS-safelisted ones.
   * Default: `["content-type"]`, which a JSON body needs. A token header
   * (`authorization`, `x-widget-token`) has to be listed.
   */
  headers?: readonly string[];
  /** Response headers the page may read beyond the safelisted ones (`Access-Control-Expose-Headers`). */
  exposeHeaders?: readonly string[];
  /**
   * Sends `Access-Control-Allow-Credentials: true`, so the browser includes
   * cookies and the page may read the answer. Only with a list of exact
   * origins: refused with `"*"` and with `"null"` in the list, and never sent
   * to a request from `Origin: null`. Default: `false`.
   */
  credentials?: boolean;
  /** How long, in seconds, a browser may cache the preflight. Default: 600. */
  maxAge?: number;
};

const DEFAULT_HEADERS = ["content-type"];
const DEFAULT_MAX_AGE = 600;

/** An HTTP token: a method or a header name. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** `scheme://host[:port]`, as a browser serializes an origin. */
function isSerializedOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.origin !== "null" && url.origin === value;
  } catch {
    return false;
  }
}

/** A policy as gemi answers it: `origins` is `"*"` or a list. */
export type NormalizedCorsPolicy = Omit<CorsPolicy, "origins"> & { origins: "*" | readonly string[] };

/**
 * `policy` with a single origin turned into a list, or a throw when it is not
 * one gemi can answer safely, at the time the route is declared. `where`
 * names the route or router in the message.
 */
export function normalizeCorsPolicy(policy: CorsPolicy, where: string): NormalizedCorsPolicy {
  const fail = (reason: string): never => {
    throw new Error(`CORS policy on ${where}: ${reason}`);
  };
  if (policy === null || typeof policy !== "object") {
    fail('expected an object such as { origins: "*" } or `false`.');
  }
  const origins =
    policy.origins === "*" ? "*" : typeof policy.origins === "string" ? [policy.origins] : policy.origins;
  if (origins !== "*") {
    if (!Array.isArray(origins) || origins.length === 0) {
      fail('`origins` must be "*", an origin or a non-empty list of origins.');
    }
    for (const origin of origins) {
      if (origin === "*") {
        fail('"*" goes on its own (`origins: "*"`), not in a list.');
      }
      if (origin !== "null" && !isSerializedOrigin(origin)) {
        fail(`"${origin}" is not an origin. Write scheme, host and port only, e.g. "https://shop.example".`);
      }
    }
  }
  if (policy.credentials) {
    if (origins === "*") {
      fail("`credentials: true` needs a list of exact origins: browsers refuse credentials with `*`, and echoing any origin with credentials lets every site read the answer as the user.");
    }
    if (origins.includes("null")) {
      fail('`credentials: true` cannot admit "null": any site can send `Origin: null` (a sandboxed frame), so credentials for it are credentials for everyone. Authenticate such callers with a token instead.');
    }
  }
  for (const method of policy.methods ?? []) {
    if (!TOKEN.test(method)) fail(`"${method}" is not a method.`);
  }
  for (const header of [...(policy.headers ?? []), ...(policy.exposeHeaders ?? [])]) {
    if (!TOKEN.test(header)) fail(`"${header}" is not a header name.`);
  }
  if (policy.maxAge !== undefined && !(Number.isInteger(policy.maxAge) && policy.maxAge >= 0)) {
    fail("`maxAge` must be a whole number of seconds.");
  }
  return { ...policy, origins };
}

function admits(policy: NormalizedCorsPolicy, origin: string) {
  return policy.origins === "*" || policy.origins.includes(origin);
}

/** Whether a request from `origin` gets `Access-Control-Allow-Credentials`. */
function allowsCredentials(policy: NormalizedCorsPolicy, origin: string) {
  return policy.credentials === true && policy.origins !== "*" && origin !== "null";
}

function setOriginHeaders(headers: Headers, policy: NormalizedCorsPolicy, origin: string) {
  headers.set("Access-Control-Allow-Origin", policy.origins === "*" ? "*" : origin);
  if (allowsCredentials(policy, origin)) {
    headers.set("Access-Control-Allow-Credentials", "true");
  } else {
    // A `cors` middleware on the same route may have set it; the route's
    // policy is the answer, and it allows none here.
    headers.delete("Access-Control-Allow-Credentials");
  }
}

function addVary(headers: Headers, names: string[]) {
  const current = (headers.get("Vary") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (current.includes("*")) return;
  const lower = current.map((name) => name.toLowerCase());
  for (const name of names) {
    if (!lower.includes(name.toLowerCase())) current.push(name);
  }
  headers.set("Vary", current.join(", "));
}

/**
 * Writes the policy's headers for a request from `origin` onto `headers`.
 * With a list of origins the answer depends on the request's, so it always
 * varies on it, even for a request without one: a cache must not hand an
 * origin's answer to another.
 */
function applyCorsHeaders(headers: Headers, policy: NormalizedCorsPolicy, origin: string | null) {
  if (policy.origins !== "*") {
    addVary(headers, ["Origin"]);
  }
  if (!origin || !admits(policy, origin)) {
    return;
  }
  setOriginHeaders(headers, policy, origin);
  if (policy.exposeHeaders?.length) {
    headers.set("Access-Control-Expose-Headers", policy.exposeHeaders.join(", "));
  }
}

/**
 * `response` with `policy`'s CORS headers for `request`. Changed in place,
 * which keeps a sized file body as it is; a Response from `fetch` (a proxy
 * route) has immutable headers and is rebuilt around the same body.
 */
export function withCorsPolicy(response: Response, policy: NormalizedCorsPolicy, request: Request): Response {
  const origin = request.headers.get("Origin");
  try {
    applyCorsHeaders(response.headers, policy, origin);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    applyCorsHeaders(headers, policy, origin);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** Whether `request` is a CORS preflight rather than a plain `OPTIONS`. */
export function isPreflight(request: Request) {
  return request.method === "OPTIONS" && request.headers.has("Access-Control-Request-Method");
}

/**
 * The answer to a preflight for a path whose methods carry these policies
 * (`undefined` for a method without one). A preflight the policy does not
 * allow — an origin it does not admit, a method it does not cover, a request
 * header it does not list — is a `204` with no CORS headers, which the browser
 * reports as a CORS failure, so the request itself is never sent.
 *
 * It runs no middleware: a preflight carries no credentials and asks only
 * what the route would accept.
 */
export function preflightResponse(
  request: Request,
  policies: Record<string, NormalizedCorsPolicy | undefined>,
): Response {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const requested = request.headers.get("Access-Control-Request-Method")!.trim().toUpperCase();
  const policy = policies[requested];
  addVary(headers, ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]);

  if (!policy || !origin || !admits(policy, origin)) {
    return new Response(null, { status: 204, headers });
  }
  // The methods this policy answers on the path: the path's own unless the
  // policy narrows them.
  const pathMethods = Object.keys(policies).filter((method) => policies[method] === policy);
  const methods = policy.methods
    ? policy.methods.map((method) => method.toUpperCase()).filter((method) => pathMethods.includes(method))
    : pathMethods;
  if (!methods.includes(requested)) {
    return new Response(null, { status: 204, headers });
  }
  const allowedHeaders = (policy.headers ?? DEFAULT_HEADERS).map((name) => name.toLowerCase());
  const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((name) => !allowedHeaders.includes(name))) {
    return new Response(null, { status: 204, headers });
  }

  setOriginHeaders(headers, policy, origin);
  headers.set("Access-Control-Allow-Methods", methods.join(", "));
  if (allowedHeaders.length) {
    headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
  }
  headers.set("Access-Control-Max-Age", String(policy.maxAge ?? DEFAULT_MAX_AGE));
  return new Response(null, { status: 204, headers });
}
