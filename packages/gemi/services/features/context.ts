import { RequestContext, sessionId } from "../../http/requestContext";
import type { ResolvedFeaturesConfig } from "./config";
import type { EvaluationContext } from "./types";

export interface FeatureSubject {
  user?: Record<string, any> | null;
  attributes?: Record<string, unknown>;
  /** Overrides the bucketing subject outright — an org id, a device id. */
  subjectId?: string;
}

/**
 * Builds the context a flag is evaluated against from the ambient request.
 *
 * Two decisions worth stating:
 *
 * **The user comes from the request store, not `Auth.user()`.** `Auth.user()`
 * throws `AuthenticationError` when nobody is signed in and performs a session
 * lookup to find out. Flags have to be evaluable on an anonymous marketing page
 * without either, so this reads `store.user` and accepts `null`. The consequence
 * is worth knowing: on a route with no `auth` middleware, where nothing has
 * called `Auth.user()`, `ctx.user` is `null` and user-targeted rules do not
 * match. The fix an application reaches for is the `auth` middleware it already
 * has.
 *
 * **No request is not an error.** A job, a cron tick or a console command has no
 * store, and `Features.enabled()` there answers with an anonymous context rather
 * than throwing. `Features.for({ user })` is the explicit form when a background
 * task needs to evaluate as somebody.
 */
export async function contextFromRequest(
  config: ResolvedFeaturesConfig,
  warn: (message: string) => void = () => {},
): Promise<EvaluationContext> {
  const store = RequestContext.getStore();
  const req = store?.req ?? null;

  let path: string | null = null;
  if (req?.rawRequest?.url) {
    try {
      path = new URL(req.rawRequest.url).pathname;
    } catch {
      path = null;
    }
  }

  return {
    user: store?.user ?? null,
    attributes: await resolveAttributes(config, warn),
    request: {
      path,
      routePath: req?.routePath ?? null,
      locale: store?.locale ?? null,
    },
    anonymousId: sessionId(),
    now: new Date(),
  };
}

/** The same shape, from an explicit subject rather than the ambient request. */
export function contextFromSubject(subject: FeatureSubject): EvaluationContext {
  return {
    user: subject.user ?? null,
    attributes: subject.attributes ?? {},
    request: { path: null, routePath: null, locale: null },
    // `subjectId` lands here because this is what `subjectFor` falls back to
    // when the bucketing path resolves to nothing — so passing one buckets on
    // it without the caller having to also set `bucketBy`.
    anonymousId: subject.subjectId ?? null,
    now: new Date(),
  };
}

async function resolveAttributes(
  config: ResolvedFeaturesConfig,
  warn: (message: string) => void,
): Promise<Record<string, unknown>> {
  if (!config.context) return {};

  try {
    const store = RequestContext.getStore();
    return (await config.context(store?.req ?? null)) ?? {};
  } catch (error) {
    // An application's attribute hook throwing must not take the page down —
    // it runs on every request, inside the render path. Degrade to no
    // attributes, which makes attribute-targeted rules simply not match.
    warn(
      `The \`context\` hook in app/config/features.ts threw; evaluating with no attributes. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}
