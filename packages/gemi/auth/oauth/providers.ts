import { featureOn } from "../../services/features/gate";
import type { HttpRequest } from "../../http/HttpRequest";
import { RequestContext } from "../../http/requestContext";
import { authSwitchOn, oauthProviderEntry, type OAuthProviderEntry } from "../config";
import type { OAuthProvider } from "./OAuthProvider";

/** The ambient request, or `null` outside one. */
function ambientRequest(): HttpRequest<any, any> | null {
  try {
    return RequestContext.getStore()?.req ?? null;
  } catch {
    return null;
  }
}

/**
 * The sign-in provider `name` names in `auth.oauthProviders`, or `null` when
 * there is none, its `feature` is off for this request (#885), its
 * `enabled` answers false for it (#1135), or the provider itself is not
 * offered on it (its `resolve` answers `null`, #1140).
 *
 * An `enabled` function is asked with `req`, else the ambient request. With
 * no request at all it answers off, as a feature read outside one does.
 */
export async function enabledOAuthProvider(
  providers: Record<string, OAuthProviderEntry>,
  name: string,
  req: HttpRequest<any, any> | null = ambientRequest(),
): Promise<OAuthProvider | null> {
  if (typeof name !== "string" || !Object.hasOwn(providers, name)) return null;
  const entry = oauthProviderEntry(providers[name]);
  if (!entry || !(await featureOn(entry.feature))) return null;
  if (entry.enabled !== undefined && entry.enabled !== true) {
    if (typeof entry.enabled === "function" && !req) return null;
    if (!(await authSwitchOn(entry.enabled, req as HttpRequest<any, any>))) return null;
  }
  const provider = entry.provider;
  if (typeof provider.isAvailable === "function" && !(await provider.isAvailable(req))) {
    return null;
  }
  return provider;
}

/** The names of the providers that are on for this request, in declaration order. */
export async function enabledOAuthProviderNames(
  providers: Record<string, OAuthProviderEntry>,
  req: HttpRequest<any, any> | null = ambientRequest(),
): Promise<string[]> {
  const names: string[] = [];
  for (const name of Object.keys(providers)) {
    if (await enabledOAuthProvider(providers, name, req)) names.push(name);
  }
  return names;
}
