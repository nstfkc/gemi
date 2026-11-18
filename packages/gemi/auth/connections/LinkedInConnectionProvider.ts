import type { ProviderConnection } from "./ConnectionManager";
import { type OAuthTokenSet, OAuthConnectionProvider } from "./OAuthConnectionProvider";
import {
  type ConnectedAccountProfile,
  type SocialConnectionProviderConfig,
  assertConnectionOf,
  bearerGet,
  idOrNull,
  missingAccountId,
  requestJson,
  stringOrNull,
} from "./social";

/** The LinkedIn member, from OpenID Connect's `GET /v2/userinfo`. */
export type LinkedInProfile = ConnectedAccountProfile & {
  /** The member id (`sub`). */
  id: string;
  /** LinkedIn has no public handle in OpenID Connect: always `null`. */
  username: string | null;
  /** `urn:li:person:<id>`: the `author` of a post made as the member. */
  authorUrn: string;
  /** Only with the `email` scope. */
  email: string | null;
};

/** An organization (company Page) the member has a role at, from `GET /rest/organizationAcls`. */
export interface LinkedInOrganization {
  /** The organization id. */
  id: string;
  /** `urn:li:organization:<id>`: the `author` of a post made as the organization. */
  urn: string;
  /** The member's role: `ADMINISTRATOR`, `DIRECT_SPONSORED_CONTENT_POSTER`, `CONTENT_ADMINISTRATOR`, … */
  role: string;
  /** The organization's name, when LinkedIn lets the app read it. */
  name: string | null;
  /** The organization's vanity name (`linkedin.com/company/<vanityName>`), when readable. */
  vanityName: string | null;
}

export interface LinkedInConnectionProviderConfig extends SocialConnectionProviderConfig {
  /**
   * The `LinkedIn-Version` (`YYYYMM`) sent to the versioned `/rest` API by
   * `organizations()`. LinkedIn retires a version about a year after release,
   * so keep it current. Default `"202610"`.
   */
  apiVersion?: string;
}

/** Sign in with OpenID Connect and post as the member. */
export const LINKEDIN_DEFAULT_SCOPES = ["openid", "profile", "w_member_social"];

/**
 * Post (and read posts) as the member's organizations. Only for apps approved
 * for LinkedIn's Community Management API.
 */
export const LINKEDIN_ORGANIZATION_SCOPES = ["w_organization_social", "r_organization_social"];

/**
 * A LinkedIn member, connected with OAuth 2.0 (three-legged) to post as the
 * member and, with the organization scopes, as their organizations:
 *
 * ```ts
 * connections: {
 *   linkedin: new LinkedInConnectionProvider({
 *     scopes: [...LINKEDIN_DEFAULT_SCOPES, ...LINKEDIN_ORGANIZATION_SCOPES],
 *   }),
 * }
 * ```
 *
 * Access tokens last 60 days. LinkedIn issues refresh tokens (365 days) only
 * to apps it has enabled for them; without one, an expired connection reads
 * `needs_reconnect`. LinkedIn documents no revocation endpoint, so `revoke()`
 * throws `revoke_unsupported` unless `revokeUrl` is set; use `disconnect()`.
 * `providerAccountId` is the member id (`sub`), and `onConnected` gets a
 * `LinkedInProfile`.
 */
export class LinkedInConnectionProvider extends OAuthConnectionProvider {
  readonly apiVersion: string;

  constructor(config: LinkedInConnectionProviderConfig = {}) {
    super({
      authorizeUrl: config.authorizeUrl ?? "https://www.linkedin.com/oauth/v2/authorization",
      tokenUrl: config.tokenUrl ?? "https://www.linkedin.com/oauth/v2/accessToken",
      revokeUrl: config.revokeUrl,
      apiBaseUrl: config.apiBaseUrl ?? "https://api.linkedin.com",
      clientId: config.clientId ?? process.env.LINKEDIN_CLIENT_ID ?? "",
      clientSecret: config.clientSecret ?? process.env.LINKEDIN_CLIENT_SECRET ?? "",
      scopes: config.scopes ?? LINKEDIN_DEFAULT_SCOPES,
      // LinkedIn's web flow documents no PKCE (only its native-app flow has it).
      pkce: false,
      authorizationParams: config.authorizationParams ?? {},
      redirectUri: config.redirectUri,
      refreshLeewaySeconds: config.refreshLeewaySeconds ?? 24 * 60 * 60,
      multiple: config.multiple ?? false,
    });
    this.apiVersion = config.apiVersion ?? "202610";
  }

  /** The code for tokens, then `/v2/userinfo` for the member. */
  override async exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const tokens = await super.exchangeCode(args);
    const profile = parseUserInfo(
      await requestJson("LinkedIn userinfo", "exchange_failed", () => bearerGet(this.userInfoUrl(), tokens.accessToken)),
    );
    return { ...tokens, providerAccountId: profile.id, profile: { ...profile } };
  }

  /** The connected member as they are now. Needs `openid` and `profile`. */
  async profile(connection: ProviderConnection): Promise<LinkedInProfile> {
    assertConnectionOf(connection, this, "LinkedInConnectionProvider.profile()");
    return parseUserInfo(
      await requestJson("LinkedIn userinfo", "request_failed", () => connection.fetch(this.userInfoUrl())),
    );
  }

  /**
   * The organizations the member has an approved role at, to post as one
   * (`author: org.urn`). Needs an organization scope (`r_organization_social`
   * or `w_organization_social`) and Community Management API access. Names
   * are read in one more call, and left `null` when LinkedIn refuses it.
   */
  async organizations(connection: ProviderConnection): Promise<LinkedInOrganization[]> {
    assertConnectionOf(connection, this, "LinkedInConnectionProvider.organizations()");
    const acls = new URL("/rest/organizationAcls", this.config.apiBaseUrl);
    acls.searchParams.set("q", "roleAssignee");
    acls.searchParams.set("state", "APPROVED");
    const payload = await requestJson("LinkedIn organizationAcls", "request_failed", () =>
      connection.fetch(acls, { headers: this.restHeaders() }),
    );
    const byId = new Map<string, LinkedInOrganization>();
    for (const element of (Array.isArray(payload.elements) ? payload.elements : []) as Record<string, unknown>[]) {
      const urn = stringOrNull(element.organization) ?? stringOrNull(element.organizationTarget);
      const id = urn?.match(/^urn:li:organization:(\d+)$/)?.[1];
      if (!urn || !id || byId.has(id)) continue;
      byId.set(id, { id, urn, role: stringOrNull(element.role) ?? "UNKNOWN", name: null, vanityName: null });
    }
    if (byId.size === 0) return [];

    // Rest.li 2.0 batch get. The ids are digits only, so nothing needs escaping.
    const lookup = `/rest/organizations?ids=List(${[...byId.keys()].join(",")})`;
    const response = await connection.fetch(lookup, { headers: this.restHeaders() });
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { results?: Record<string, Record<string, unknown>> };
      for (const [id, organization] of Object.entries(body.results ?? {})) {
        const entry = byId.get(id);
        if (!entry) continue;
        entry.name = stringOrNull(organization.localizedName);
        entry.vanityName = stringOrNull(organization.vanityName);
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
    return [...byId.values()];
  }

  /** The headers LinkedIn's versioned `/rest` API requires. */
  restHeaders(): Record<string, string> {
    return { "LinkedIn-Version": this.apiVersion, "X-Restli-Protocol-Version": "2.0.0" };
  }

  private userInfoUrl(): URL {
    return new URL("/v2/userinfo", this.config.apiBaseUrl);
  }
}

function parseUserInfo(payload: Record<string, unknown>): LinkedInProfile {
  const id = idOrNull(payload.sub);
  if (!id) throw missingAccountId("LinkedIn");
  const given = stringOrNull(payload.given_name);
  const family = stringOrNull(payload.family_name);
  return {
    id,
    name: stringOrNull(payload.name) ?? ([given, family].filter(Boolean).join(" ") || null),
    username: null,
    avatarUrl: stringOrNull(payload.picture),
    authorUrn: `urn:li:person:${id}`,
    email: stringOrNull(payload.email),
  };
}
