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

  useEffect(() => {
    if (action === "replace") {
      replace(href, { params, search } as any);
    } else {
      push(href, { params, search } as any);
    }
  }, [replace, action, push, params, search, href]);

  return <></>;
};
