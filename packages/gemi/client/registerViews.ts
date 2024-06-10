import { type ComponentType, lazy } from "react";

export function registerViews(views: any) {
  (window as any).views = Object.entries(views).reduce(
    (acc, [path, importer]) => {
      return {
        ...acc,
        [path]: lazy(
          importer as () => Promise<{ default: ComponentType<unknown> }>,
        ),
      };
    },
    {},
  );
}
