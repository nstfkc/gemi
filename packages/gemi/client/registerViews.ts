import { type ComponentType, lazy } from "react";

export function registerViews(views: any) {
  const _views = Object.entries(views).reduce((acc, [path, importer]) => {
    return {
      ...acc,
      [path]: lazy(
        importer as () => Promise<{ default: ComponentType<unknown> }>,
      ),
    };
  }, {});

  if (typeof window === "undefined") {
    globalThis.__gemi_views = _views;
  } else {
    (window as any).__gemi_views = _views;
  }
}
