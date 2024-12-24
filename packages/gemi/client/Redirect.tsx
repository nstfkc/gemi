import { ComponentProps, useEffect } from "react";
import { Link } from "./Link";

import { useNavigate } from "./useNavigate";

export const Redirect = (
  props: ComponentProps<typeof Link> & { action: "push" | "replace" },
) => {
  const { href, params = {}, search = {}, action } = props;
  const { push, replace } = useNavigate();
  useEffect(() => {
    if (action === "push") {
      push(href, { params, search } as any);
    } else {
      replace(href, { params, search } as any);
    }
  }, []);

  return null;
};
