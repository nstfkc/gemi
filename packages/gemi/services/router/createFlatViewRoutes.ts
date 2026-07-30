import type { HttpRequest } from "../../http";
import type { ViewRoutes } from "../../http/ViewRouter";

export type ViewRouteExec = (req: HttpRequest<any, any>) => any; // TODO: fix type

/**
 * One entry per segment of a route, parallel to `exec` — `segments[i]` is what
 * `exec[i]` renders. `path` is the segment's own route pattern, prefixed by
 * every ancestor, so the last segment's `path` is always the flat route key.
 *
 * Partial rendering compares these pairwise between the route the client is on
 * and the one it is navigating to, to find the segments it can skip.
 */
export type ViewRouteSegment = {
  path: string;
  viewPath: string;
  /** Layout opted out of being skipped, via `alwaysRun()`. */
  alwaysRun?: boolean;
};

export type FlatViewRoutes = Record<
  string,
  {
    exec: ViewRouteExec[];
    middleware: (string | any)[];
    viewPath: string;
    segments: ViewRouteSegment[];
  }
>;

function removeGroupPrefix(input: string) {
  // Remove all (str) patterns
  const withoutParentheses = input.replace(/\([^)]*\)/g, "");

  // Remove all double slashes // by replacing with single slash
  const withoutDoubleSlashes = withoutParentheses.replace(/\/\//g, "/");
  return withoutDoubleSlashes;
}

/** How a child route path is mounted under its parent's. */
function joinRoutePath(prefix: string, path: string) {
  if (prefix === "/") return path;
  if (path === "/") return prefix;
  return `${prefix}${path}`;
}

/**
 * A segment path is compared against other segment paths, so it has to be
 * spelled one way only. A group as the last part of a path (`/app/(private)`)
 * leaves a trailing slash behind once the group is stripped.
 */
function segmentPath(path: string) {
  const withoutGroups = removeGroupPrefix(path);
  return withoutGroups.length > 1 ? withoutGroups.replace(/\/$/, "") : withoutGroups;
}

function prefixSegments(prefix: string, segments: ViewRouteSegment[]) {
  return segments.map((segment) => ({
    ...segment,
    path: segmentPath(joinRoutePath(prefix, segment.path)),
  }));
}

export function createFlatViewRoutes(routes: ViewRoutes) {
  const flatRoutes: FlatViewRoutes = {};

  for (const [routePath, viewConfigOrViewRouter] of Object.entries(routes)) {
    if ("run" in viewConfigOrViewRouter) {
      const route = viewConfigOrViewRouter;
      if ("children" in route) {
        const children = new route.children();
        const result = createFlatViewRoutes(children.routes);

        for (const [path, { exec, middleware, segments }] of Object.entries(
          result,
        )) {
          const _key = joinRoutePath(routePath, path);

          const handler = (req: HttpRequest<any, any>) =>
            route.run.call(route, req, routePath);

          flatRoutes[removeGroupPrefix(_key)] = {
            exec: [handler, ...exec],
            middleware: [...route.middlewares, ...middleware],
            viewPath: route.viewPath,
            segments: [
              {
                path: segmentPath(routePath),
                viewPath: route.viewPath,
                ...(route.alwaysRuns ? { alwaysRun: true } : {}),
              },
              ...prefixSegments(routePath, segments),
            ],
          };
        }
      } else {
        const handler = (req: HttpRequest<any, any>) =>
          route.run.call(route, req, routePath);
        flatRoutes[removeGroupPrefix(routePath)] = {
          exec: [handler],
          middleware: route.middlewares,
          viewPath: route.viewPath,
          segments: [{ path: segmentPath(routePath), viewPath: route.viewPath }],
        };
      }
    } else {
      const router = new viewConfigOrViewRouter();
      const result = createFlatViewRoutes(router.routes);
      for (const [
        path,
        { exec, middleware, viewPath, segments },
      ] of Object.entries(result)) {
        const _key = joinRoutePath(routePath, path);
        flatRoutes[removeGroupPrefix(_key)] = {
          exec,
          middleware: [...router.middlewares, ...middleware],
          viewPath,
          segments: prefixSegments(routePath, segments),
        };
      }
    }
  }

  return Object.fromEntries(
    Object.entries(flatRoutes).sort(([a], [b]) => {
      const x = a.split("/").length + a.split(":").length;
      const y = b.split("/").length + b.split(":").length;
      return x - y;
    }),
  );
}
