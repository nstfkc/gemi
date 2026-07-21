import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";

test("Button renders its children", () => {
  const html = renderToStaticMarkup(<Button>Click me</Button>);
  expect(html).toContain("Click me");
  expect(html).toContain("<button");
});

test("Button applies the destructive variant classes", () => {
  const html = renderToStaticMarkup(
    <Button variant="destructive">Delete</Button>,
  );
  expect(html).toContain("bg-destructive");
});
