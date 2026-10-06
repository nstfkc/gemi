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
  error,
}: {
  session?: unknown;
  redirectTo?: string | null;
  /** Why the callback was refused: `access_denied`, `invalid_state`, `email_not_verified`, … */
  error?: string;
}) {
  if (session) {
    // The page the sign-in link forwarded as `?redirect=`, else `redirectPath`.
    // Cast because it is a runtime path, not one of the typed routes.
    return <Redirect action="replace" href={(redirectTo ?? "/chat") as "/chat"} />;
  }

  // On a refusal `redirectTo` is the page the sign-in was meant to return to,
  // carried back so another try still lands there.
  const retry = redirectTo ? `/auth/sign-in?redirect=${encodeURIComponent(redirectTo)}` : "/auth/sign-in";

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">We could not sign you in</h1>
      <p className="text-muted-foreground text-sm">
        {error === "access_denied"
          ? "The sign-in was cancelled. Try again, or use your email address."
          : error === "email_not_verified"
            ? "The provider has not verified your email address. Verify it there, or use your email address here."
            : "The provider did not return a usable account. Try again, or use your email address."}
      </p>
      <a
        href={retry}
        className="bg-primary text-primary-foreground mt-2 rounded-md px-4 py-2 text-sm font-medium"
      >
        Back to sign in
      </a>
    </main>
  );
}
