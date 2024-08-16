import type { ComponentProps } from "react";

import { applyParams } from "../utils/applyParams";
import { useLocation } from "./ClientRouterContext";
import type { ViewPaths, UrlParser } from "./types";
import { useRouter } from "./useRouter";

type BaseLinkProps<T extends ViewPaths> = Omit<ComponentProps<"a">, "href"> & {
  active?: boolean;
  href: T;
  search?: Record<string, string | number | boolean | undefined | null>;
};

type LinkProps<T extends ViewPaths> =
  UrlParser<T> extends never
    ? BaseLinkProps<T>
    : BaseLinkProps<T> & { params: UrlParser<T> };

export const Link = <T extends ViewPaths>(props: LinkProps<T>) => {
  const {
    href,
    onClick,
    active = false,
    params = {},
    search = {},
    ...rest
  } = { params: {}, ...props };
  const { push } = useRouter();
  const { pathname } = useLocation();

  const path = applyParams(href, params);

  return (
    <a
      data-active={active || pathname === path}
      href={path}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
        push(href, { search, params } as any);
      }}
      {...rest}
    />
  );
};
