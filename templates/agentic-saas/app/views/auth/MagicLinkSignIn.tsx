import { Redirect } from "gemi/client";

/**
 * Where `/auth/sign-in/magic-link?token=…` lands.
 *
 * gemi's own auth router mounts this view — the app does not list it in
 * `app/http/routes/view.ts` — so the file has to exist under exactly this name
 * or the production server fails to boot with "not found in server manifest".
 * The same is true of `OauthCallback` next door. That is the whole reason these
 * two are here while `ForgotPassword`/`ResetPassword` are not: those are the
 * app's own routes, and optional.
 *
 * The handler behind it has already consumed the token by the time this
 * renders, so a `session` means the link worked and its absence means it was
 * expired, already spent, or forged.
 */
export default function MagicLinkSignIn({ session }: { session?: unknown }) {
  if (session) {
    return <Redirect action="replace" href="/chat" />;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">This link has expired</h1>
      <p className="text-muted-foreground text-sm">
        Magic links can only be used once. Ask for a new one and it will work.
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
