import { Redirect, useNavigate } from "gemi/client";
import { useEffect } from "react";

export default function OauthSignIn({ session }) {
  return (
    <div
      ref={() => {
        if (session) {
          window.location.href = "/dashboard";
        }
      }}
    >
      Loading
    </div>
  );
}
