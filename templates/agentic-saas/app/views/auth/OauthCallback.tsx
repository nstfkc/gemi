import { Redirect } from "gemi/client";

/**
 * Where `/auth/:provider/callback` lands, mounted by gemi's auth router rather
 * than by this app — see the note in `MagicLinkSignIn.tsx` for why the file has
 * to exist under this exact name.
 *
 * A full-page navigation rather than a client-side one: the provider redirect
 * arrives in a popup or a fresh top-level load with no router state, and the
 * session cookie was set on this response. Reloading is what makes the rest of
 * the app read it.
 */
export default function OauthCallback({
  session,
  redirectTo,
}: {
  session?: unknown;
  redirectTo?: string;
}) {
  if (session) {
    // The page the sign-in link forwarded as `?redirect=`, else `redirectPath`.
    // Cast because it is a runtime path, not one of the typed routes.
    return <Redirect action="replace" href={(redirectTo ?? "/chat") as "/chat"} />;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">We could not sign you in</h1>
      <p className="text-muted-foreground text-sm">
        The provider did not return a usable account. Try again, or use your email address.
      </p>
      <a
        href="/auth/sign-in"
        className="bg-primary text-primary-foreground mt-2 rounded-md px-4 py-2 text-sm font-medium"
      >
        Back to sign in
      </a>
    </main>
  );
}
