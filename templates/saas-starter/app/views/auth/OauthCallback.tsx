import { Redirect, useNavigate } from "gemi/client";
import { useEffect } from "react";

export default function OauthSignIn({ session, redirectTo }) {
  if(session) {
    // `redirectTo` is the page the sign-in link forwarded as `?redirect=`, or
    // `redirectPath`. Serialized, never spliced raw into the script.
    const target = JSON.stringify(redirectTo ?? "/dashboard").replaceAll("<", "\\u003c");
    return <script
      dangerouslySetInnerHTML={{
        __html: `window.location.href=${target}`,
      }}
    />
  }
}
