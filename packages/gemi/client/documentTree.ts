import { createElement, Fragment, type ReactElement, type ReactNode } from "react";

/**
 * The top-level children of a hydrated page, on the server and in the browser
 * alike: the `modulepreload` links, then the head content (stylesheets, theme
 * script), then the root.
 *
 * `useId` derives an id from the element's position in the tree, and that
 * includes the root's index among its siblings. The server has a varying
 * number of links and styles in front of the root (none in dev, several in a
 * build, one more with a theme), the browser has none at all, so each lives in
 * a fragment of its own: the root is always the third of three children and
 * every id matches between the server render and hydration (#1200).
 *
 * Fragments change nothing about hoisting: the links, styles and script still
 * land in `<head>`.
 */
export function documentChildren(
  preloads: ReactNode[],
  head: ReactNode[],
  root: ReactElement,
): ReactNode[] {
  return [
    createElement(Fragment, { key: "preloads" }, ...preloads),
    createElement(Fragment, { key: "head" }, ...head),
    root,
  ];
}

/** The element the browser hydrates `document` with: `root` in the page's shape. */
export function documentElement(root: ReactElement): ReactElement {
  return createElement(Fragment, null, ...documentChildren([], [], root));
}
