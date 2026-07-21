import { expect, test } from "vitest";
import { HomeController } from "./HomeController";

test("HomeController.index returns the greeting message", async () => {
  const controller = new HomeController();
  const result = await controller.index();
  expect(result).toEqual({ message: "Hello from HomeController 1" });
});
