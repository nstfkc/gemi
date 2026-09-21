/**
 * The prefix every api route is served under. The browser adds it when it
 * fetches (`/api${path}`) and the server strips it before matching, so an api
 * router's own paths never carry it.
 */
export const API_PREFIX = "/api";

/**
 * Whether a request pathname is an api request: `/api` itself or anything
 * under `/api/`. A bare `startsWith("/api")` also claims `/apidocs`,
 * `/api-keys` and `/apiary`, so a view route there would never render — the
 * api dispatcher would answer its 404 JSON instead.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/**
 * The api router path a request pathname addresses: `/api/users/1` is
 * `/users/1`, `/api/` is `/` and `/api` is `""`. Only the leading prefix is
 * stripped — `replace("/api", "")` would also strip an `/api` inside the path
 * of a request that did not start with one (`/files/api` becoming `/files`).
 * A pathname outside `/api` comes back unchanged, so the dispatcher can still
 * be handed a request by its route path directly.
 */
export function apiPath(pathname: string): string {
  return isApiPath(pathname) ? pathname.slice(API_PREFIX.length) : pathname;
}
