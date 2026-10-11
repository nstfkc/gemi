/**
 * Type-level tests for `defineAuthConfig` (#885).
 *
 * `oauthProviders` widened from `Record<string, OAuthProvider>` to
 * `Record<string, OAuthProviderEntry>`. An app that reads a provider back off
 * its config (`auth.oauthProviders!.google!.getRedirectUrl(...)`) must keep
 * compiling, so `defineAuthConfig` returns the config as written rather than
 * `AuthConfig`. Every `@ts-expect-error` below must keep biting.
 *
 * Run with `bun run typecheck` (or `bun run test:types`).
 */
import { describe, expectTypeOf, test } from "vitest";

import { defineAuthConfig, type AuthConfig, type OAuthProviderEntry } from "./config";
import { GoogleOAuthProvider } from "./oauth/GoogleOAuthProvider";
import { InstagramOAuthProvider } from "./oauth/InstagramOAuthProvider";

declare const GOOGLE_SIGN_IN: boolean;
declare const INSTAGRAM_SIGN_IN: boolean;
const FIGMA = "figma";

describe("defineAuthConfig", () => {
  test("a provider read back off the config is the provider, as before #885", () => {
    const auth = defineAuthConfig({
      oauthProviders: {
        ...(GOOGLE_SIGN_IN && { google: new GoogleOAuthProvider({ redirectPath: "/cb" }) }),
        ...(INSTAGRAM_SIGN_IN && { instagram: new InstagramOAuthProvider() }),
        [FIGMA]: new GoogleOAuthProvider(),
      },
    });

    expectTypeOf(auth.oauthProviders!.google!).toEqualTypeOf<GoogleOAuthProvider>();
    expectTypeOf(auth.oauthProviders!.google!.getRedirectUrl).toBeFunction();
    expectTypeOf(auth.oauthProviders!.instagram!.createUsersWithoutEmail).toEqualTypeOf<boolean>();
    expectTypeOf(auth.oauthProviders.figma).toEqualTypeOf<GoogleOAuthProvider>();
  });

  test("a feature-gated entry reads back as the wrapper", () => {
    const auth = defineAuthConfig({
      oauthProviders: {
        instagram: { provider: new InstagramOAuthProvider(), feature: "instagram-sign-in" as never },
      },
    });
    expectTypeOf(auth.oauthProviders.instagram.provider).toEqualTypeOf<InstagramOAuthProvider>();
  });

  test("the result is still an AuthConfig, and callbacks are still typed from it", () => {
    const auth = defineAuthConfig({
      basePath: "/auth",
      onAuthenticated: ({ user }) => {
        expectTypeOf(user).not.toBeAny();
      },
    });
    expectTypeOf(auth).toMatchTypeOf<AuthConfig>();

    const untyped: AuthConfig = { oauthProviders: { google: new GoogleOAuthProvider() } };
    expectTypeOf(defineAuthConfig(untyped).oauthProviders).toEqualTypeOf<
      Record<string, OAuthProviderEntry> | undefined
    >();
  });

  test("a key AuthConfig does not know, or a wrong value, is still an error", () => {
    defineAuthConfig({
      // @ts-expect-error not an AuthConfig key
      redirectPth: "/dashboard",
    });
    defineAuthConfig({
      // @ts-expect-error not a provider
      oauthProviders: { google: { getRedirectUrl: 1 } },
    });
    // @ts-expect-error a number is not a path
    defineAuthConfig({ redirectPath: 1 });
  });
});
