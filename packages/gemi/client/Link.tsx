import type { ComponentProps } from "react";

import { applyParams } from "../utils/applyParams";
import { useLocation } from "./ClientRouterContext";
import type { ViewPaths, UrlParser } from "./types";
import { useNavigate } from "./useNavigate";

type Search = Record<string, string | number | boolean | undefined | null>;
type BaseLinkProps<T extends ViewPaths> = Omit<ComponentProps<"a">, "href"> & {
  active?: boolean;
  href: T;
  search?: Search;
};

type LinkProps<T extends ViewPaths> =
  UrlParser<T> extends never
    ? BaseLinkProps<T>
    : BaseLinkProps<T> & { params: UrlParser<T> };

function normalizeSearch(search: Search): Record<string, string> {
  return Object.fromEntries(
    Object.entries(search)
      .filter(([k, v]) => v === undefined || v === null)
      .map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;
}

export const Link = <T extends ViewPaths>(props: LinkProps<T>) => {
  const {
    href,
    onClick,
    active = false,
    params = {},
    search = {},
    ...rest
  } = { params: {}, ...props };
  const { push } = useNavigate();
  const { pathname } = useLocation();
  const searchParams = new URLSearchParams(normalizeSearch(search));

  const path = applyParams(href, params);
  const _href = [path, searchParams.toString()]
    .filter((s) => s.length > 0)
    .join("?");
  return (
    <a
      data-active={active || pathname === path}
      href={_href}
      onClick={(e) => {
        if (typeof window !== "undefined") {
          if (
            `${window.location.pathname}${window.location.search}` === _href
          ) {
            e.preventDefault();
            return;
          }
        }
        e.preventDefault();
        onClick?.(e);
        push(href, { search, params } as any);
      }}
      {...rest}
    />
  );
};
