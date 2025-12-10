import { Redirect, useNavigate } from "gemi/client";
import { useEffect } from "react";

export default function OauthSignIn({ session }) {
  if(session) {
    return <script
      dangerouslySetInnerHTML={{
        __html: `window.location.href="/dashboard"`,
      }}
    />
  }
}
