import { test, expect } from "vitest";
type Tree = Record<string, string | [string, Tree]>;

const tree: Tree = {
  "/": [
    "HomeLayout",
    {
      "/": "Home",
      "/product": [
        "ProductLayout",
        {
          "/": "ProductList",
          "/:productId": "ProductDetail",
        },
      ],
    },
  ],
};

const flat = {
  "/": ["HomeLayout", "Home"],
  "/product": ["HomeLayout", "ProductLayout", "ProductList"],
  "/product/:productId": ["HomeLayout", "ProductLayout", "ProductDetail"],
};

function flattenTree(tree: Tree) {
  const out: Record<string, string[]> = {};

  for (const [path, view] of Object.entries(tree)) {
    for (const [key, value] of Object.entries(view)) {
      if (Array.isArray(value)) {
        out[key] = value;
      } else {
        out[key] = [value];
      }
    }
  }

  return out;
}

test("flat", () => {
  expect(flattenTree(tree)).toEqual(flat);
});
