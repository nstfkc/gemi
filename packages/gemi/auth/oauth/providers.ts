import { featureOn } from "../../services/features/gate";
import { oauthProviderEntry, type OAuthProviderEntry } from "../config";
import type { OAuthProvider } from "./OAuthProvider";

/**
 * The sign-in provider `name` names in `auth.oauthProviders`, or `null` when
 * there is none or its `feature` is off for this request (#885).
 */
export async function enabledOAuthProvider(
  providers: Record<string, OAuthProviderEntry>,
  name: string,
): Promise<OAuthProvider | null> {
  if (typeof name !== "string" || !Object.hasOwn(providers, name)) return null;
  const entry = oauthProviderEntry(providers[name]);
  if (!entry || !(await featureOn(entry.feature))) return null;
  return entry.provider;
}

/** The names of the providers that are on for this request, in declaration order. */
export async function enabledOAuthProviderNames(
  providers: Record<string, OAuthProviderEntry>,
): Promise<string[]> {
  const names: string[] = [];
  for (const name of Object.keys(providers)) {
    if (await enabledOAuthProvider(providers, name)) names.push(name);
  }
  return names;
}
