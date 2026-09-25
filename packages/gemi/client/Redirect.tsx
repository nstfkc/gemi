import { useEffect } from "react";
import type { LinkProps } from "./Link";
import type { ViewPaths } from "./types";

import { useNavigate } from "./useNavigate";

// Typed against `LinkProps` directly: `ComponentProps<typeof Link>` comes out
// `{}` now that `Link` is overloaded, which left `action` the only prop.
export const Redirect = <T extends ViewPaths>(
  props: LinkProps<T> & { action: "push" | "replace" },
) => {
  const {
    href,
    params = {},
    search = {},
    action = "replace",
  } = props as LinkProps<T> & {
    action: "push" | "replace";
    params?: Record<string, unknown>;
  };
  const { push, replace } = useNavigate();

  // The destination decides when to navigate again, because none of the parts
  // it is made of keep their identity: `useNavigate` builds `push` and
  // `replace` fresh on every render, and `params` and `search` fall back to
  // new objects each time. Depending on them directly navigated on every
  // render of whatever holds this — with `action="push"`, one history entry
  // per render, which the back button then has to walk back through.
  const target = JSON.stringify([action, href, params, search]);

  useEffect(() => {
    if (action === "replace") {
      replace(href, { params, search } as any);
    } else {
      push(href, { params, search } as any);
    }
  }, [target]);

  return <></>;
};
