export default function OauthSignIn({
  session,
  redirectTo,
  error,
}: {
  session?: unknown;
  redirectTo?: string | null;
  error?: string;
}) {
  // Signed in: `redirectTo` is the page the sign-in link forwarded as
  // `?redirect=`, or `redirectPath`. Refused: back to the sign-in page with the
  // reason (`access_denied`, `invalid_state`, `email_not_verified`, …) and the
  // page to return to after another try. `auth.oauthFailurePath` does the same
  // with a server redirect instead.
  let href = redirectTo ?? "/dashboard";
  if (!session) {
    const search = new URLSearchParams({ error: error ?? "oauth_failed" });
    if (redirectTo) search.set("redirect", redirectTo);
    href = `/auth/sign-in?${search}`;
  }
  // Serialized, never spliced raw into the script.
  const target = JSON.stringify(href).replaceAll("<", "\\u003c");
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `window.location.href=${target}`,
      }}
    />
  );
}
