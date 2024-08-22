import type { ComponentProps } from "react";

import { applyParams } from "../utils/applyParams";
import { useLocation } from "./ClientRouterContext";
import type { UrlParser, ViewResult } from "./types";
import { useNavigate } from "./useNavigate";
import type { ViewRPC } from "./rpc";

type Views = {
  [K in keyof ViewRPC as K extends `view:${infer P}`
    ? P
    : never]: ViewResult<K>;
};

type Search = Record<string, string | number | boolean | undefined | null>;

type LinkBaseProps<T extends keyof Views, S = Views[T]["input"]> = Omit<
  ComponentProps<"a">,
  "href"
> & {
  active?: boolean;
  href: T;
  search?: S;
  params: UrlParser<T>;
};

type LinkProps<T extends keyof Views, U = UrlParser<T>> =
  U extends Record<string, never>
    ? Omit<LinkBaseProps<T>, "params">
    : LinkBaseProps<T>;

function normalizeSearch(search: Search): Record<string, string> {
  return Object.fromEntries(
    Object.entries(search)
      .filter(([_k, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;
}

export const Link = <T extends keyof Views>(props: LinkProps<T>) => {
  const {
    href,
    onClick,
    active = false,
    params = {},
    search = {},
    ...rest
  } = { params: {}, search: {}, ...props };
  const { push } = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(normalizeSearch(search));

  const path = applyParams(href, params);
  const targetHref = [path, searchParams.toString()]
    .filter((s) => s.length > 0)
    .join("?");

  const currentHref = [location.pathname, location.search]
    .filter((item) => !!item)
    .join("");

  return (
    <a
      data-active={active || currentHref === targetHref}
      data-current={currentHref}
      href={targetHref}
      onClick={(e) => {
        if (typeof window !== "undefined") {
          if (currentHref === targetHref) {
            e.preventDefault();
            return;
          }
        }
        e.preventDefault();
        onClick?.(e);
        push(href, {
          search,
          params,
          shallow: path === window.location.pathname,
        } as any);
      }}
      {...rest}
    />
  );
};
