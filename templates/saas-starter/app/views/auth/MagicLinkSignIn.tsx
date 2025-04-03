import { Redirect } from "gemi/client";

export default function MagicLinkSignIn({ session }) {
  if (session) {
    return <Redirect action="replace" href="/dashboard" />;
  }
  return <div>Error</div>;
}
