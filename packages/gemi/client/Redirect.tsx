import { type ComponentProps, useEffect } from "react";
import type { Link } from "./Link";

import { useNavigate } from "./useNavigate";

const EMPTY_OBJECT = {};

export const Redirect = (
  props: ComponentProps<typeof Link> & { action: "push" | "replace" },
) => {
  const {
    href,
    params = EMPTY_OBJECT,
    search = EMPTY_OBJECT,
    action = "replace",
  } = props;
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
