import { Router } from "./Router";

/**
 * @description Takes a route configuration tree and returns a flattened list
 */
export function flattenRoutes(
  routes: Record<string, any>,
  prevPathPattern = "",
) {
  const out: Record<string, any> = {};
  //
  for (const [pathPattern, route] of Object.entries(routes)) {
    const key = [prevPathPattern, pathPattern]
      .filter((p) => p.length > 0)
      .join("/");

    if (route instanceof Router) {
      // recursive if route is a Router instance
    } else {
      if (route.kind === "view") {
        out[key] = route.exec;
      }
      if (route.kind === "layout") {
        out[key] = route.exec;
      }
    }
  }
  return out;
}

// MainLayout, Home
// MainLayout, ProductsLayout, ProductsList
// MainLayout, ProductsLayout, ProductsDetail

const nestedRoutes = {
  "/": [
    (app: App) => ["HomeLayout"],
    {
      "/": (app: App) => ["Home"],
      "/product": [
        (app: App) => ["ProductsLayout"],
        {
          "/": (app: App) => ["ProductsList"],
          "/:productId": (app: App) => ["ProductsDetail"],
        },
      ],
    },
  ],
};

const flatRoutes = {
  "/": (app: App) => [
    (req: Request) =>
      Promise.resolve({ data: { HomeLayout: { title: "Home" } }, headers: {} }),
    (req: Request) =>
      Promise.resolve({ data: { Home: { title: "Home" } }, headers: {} }),
  ],
  "/product": (app: App) => [
    (req: Request) =>
      Promise.resolve({ data: { HomeLayout: { title: "Home" } }, headers: {} }),
    (req: Request) =>
      Promise.resolve({
        data: { ProductsLayout: { title: "Products" } },
        headers: {},
      }),
    (req: Request) =>
      Promise.resolve({
        data: { ProductsList: { title: "Products List" } },
        headers: {},
      }),
  ],
  "/product/:productId": (app: App) => [
    (req: Request) =>
      Promise.resolve({ data: { HomeLayout: { title: "Home" } }, headers: {} }),
    (req: Request) =>
      Promise.resolve({
        data: { ProductsLayout: { title: "Products" } },
        headers: {},
      }),
    (req: Request) =>
      Promise.resolve({
        data: { ProductsDetail: { title: "Product Detail" } },
        headers: {},
      }),
  ],
};
