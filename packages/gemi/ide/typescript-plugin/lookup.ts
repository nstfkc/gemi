import type { RouteQuery } from "./callSite";
import type { ApiRouteEntry, HttpVerb, RouteTable, RouteTarget, ViewRouteEntry } from "./types";

export type RouteCandidate =
  | { kind: "api"; entry: ApiRouteEntry }
  | { kind: "view"; entry: ViewRouteEntry };

export interface RouteMatch {
  candidate: RouteCandidate;
  targets: RouteTarget[];
}

const VERB_ORDER: HttpVerb[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

interface RouteIndex {
  pathsByVerb: Map<HttpVerb, Set<string>>;
  viewPaths: Set<string>;
  /** Every path the walk found, of any verb or kind. */
  knownPaths: Set<string>;
}

const indexes = new WeakMap<RouteTable, RouteIndex>();

function indexOf(table: RouteTable): RouteIndex {
  const cached = indexes.get(table);
  if (cached) return cached;

  const knownPaths = new Set<string>();
  const pathsByVerb = new Map<HttpVerb, Set<string>>();
  for (const entries of table.api.values()) {
    for (const entry of entries) {
      let paths = pathsByVerb.get(entry.verb);
      if (!paths) pathsByVerb.set(entry.verb, (paths = new Set()));
      paths.add(entry.path);
      knownPaths.add(entry.path);
    }
  }
  const viewPaths = new Set<string>();
  for (const entries of table.views.values()) {
    for (const entry of entries) {
      viewPaths.add(entry.path);
      knownPaths.add(entry.path);
    }
  }

  const index = { pathsByVerb, viewPaths, knownPaths };
  indexes.set(table, index);
  return index;
}

/**
 * The routes a call site could mean, best first.
 *
 * Each signal narrows only when narrowing leaves something — a `href` pointing
 * at what turns out to be an API route, or a `method="PUT"` on a path with no
 * PUT handler, still gets the jump it can rather than none. When more than one
 * route survives, all of them are returned and the editor offers the choice;
 * that is the honest answer for a path that genuinely carries two handlers.
 */
export function lookupRoute(table: RouteTable, query: RouteQuery): RouteMatch[] {
  let candidates: RouteCandidate[] = [
    ...(table.api.get(query.path) ?? []).map((entry) => ({ kind: "api", entry }) as const),
    ...(table.views.get(query.path) ?? []).map((entry) => ({ kind: "view", entry }) as const),
  ];
  if (candidates.length === 0) return [];

  if (query.prefer) {
    candidates = narrow(candidates, (candidate) => candidate.kind === query.prefer);
  }
  if (query.verb) {
    candidates = narrow(
      candidates,
      (candidate) => candidate.kind === "api" && candidate.entry.verb === query.verb,
    );
  }
  if (query.allowedPaths) {
    const { pathsByVerb, viewPaths, knownPaths } = indexOf(table);
    const allowed = intersect(query.allowedPaths, knownPaths);
    if (allowed.size > 0) {
      candidates = narrow(candidates, (candidate) =>
        candidate.kind === "api"
          ? isSubset(allowed, pathsByVerb.get(candidate.entry.verb))
          : isSubset(allowed, viewPaths),
      );
    }
  }

  candidates.sort(compareCandidates);
  return candidates.map((candidate) => ({ candidate, targets: candidate.entry.targets }));
}

/** Applies a filter, unless doing so would leave nothing to jump to. */
function narrow(
  candidates: RouteCandidate[],
  predicate: (candidate: RouteCandidate) => boolean,
): RouteCandidate[] {
  const kept = candidates.filter(predicate);
  return kept.length > 0 ? kept : candidates;
}

/**
 * Whether every path the call site accepts is served by this verb.
 *
 * The direction matters. A `useQuery` argument accepts exactly the GET paths,
 * so testing the *accepted set* against each verb's paths identifies the verb;
 * testing one path against the set would not, because a path with both a GET
 * and a POST handler belongs to both.
 */
function isSubset(subset: ReadonlySet<string>, superset: Set<string> | undefined): boolean {
  if (!superset) return false;
  for (const value of subset) {
    if (!superset.has(value)) return false;
  }
  return true;
}

/**
 * The accepted paths, minus the ones the walk never saw.
 *
 * Without this the containment test is all-or-nothing across the whole project.
 * `keyof GetRPC` comes from the declared type of `routes` and so includes shapes
 * the walk drops — a spread entry, say (`routeTable.ts` logs one when it meets
 * one). A single such path is not in *any* verb's set, so every verb fails the
 * subset test at once, every candidate survives, and disambiguation stops
 * working at call sites nowhere near the route that was missed.
 *
 * A path the walk never saw has no row to jump to either way, so dropping it
 * from the comparison costs nothing and keeps the damage where it belongs.
 */
function intersect(
  subset: ReadonlySet<string>,
  universe: ReadonlySet<string>,
): ReadonlySet<string> {
  const kept = new Set<string>();
  for (const value of subset) {
    if (universe.has(value)) kept.add(value);
  }
  return kept;
}

function compareCandidates(a: RouteCandidate, b: RouteCandidate): number {
  if (a.kind !== b.kind) return a.kind === "api" ? -1 : 1;
  if (a.kind === "api" && b.kind === "api") {
    return VERB_ORDER.indexOf(a.entry.verb) - VERB_ORDER.indexOf(b.entry.verb);
  }
  // A path's view comes before the layout wrapping it.
  const rank = (kind: "view" | "layout") => (kind === "view" ? 0 : 1);
  return rank((a.entry as ViewRouteEntry).kind) - rank((b.entry as ViewRouteEntry).kind);
}

/** `GET /products`, `view /reports` — the heading a hover leads with. */
export function describeCandidate(candidate: RouteCandidate): string {
  return candidate.kind === "api"
    ? `${candidate.entry.verb} ${candidate.entry.path}`
    : `${candidate.entry.kind} ${candidate.entry.path}`;
}

export function describeTarget(target: RouteTarget): string {
  switch (target.kind) {
    case "controller-method":
      return `${target.containerName}.${target.name}()`;
    case "inline-handler":
      return "inline handler";
    case "view-component":
      return `${target.name} component`;
    case "route-entry":
      return `${target.containerName} routes entry`;
  }
}
