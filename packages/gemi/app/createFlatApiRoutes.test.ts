import { describe, test, expect } from "bun:test";
import { createFlatApiRoutes } from "./createFlatApiRoutes";
import { ApiRouter, HttpRequest } from "../http";
import { ResourceController } from "../http/Controller";

type Post = {};

class PostController extends ResourceController {
  async create(req: HttpRequest) {
    const post = {} as Post;
    return { post };
  }

  async update(req: HttpRequest) {
    return { message: "Post updated" };
  }

  async delete(req: HttpRequest) {
    return { message: "Post deleted" };
  }

  async list(req: HttpRequest) {
    return { message: "Post list" };
  }

  async show(req: HttpRequest) {
    return { message: "Post show" };
  }
}

class TestApiRouter extends ApiRouter {
  routes = {
    "/posts": this.resource(PostController),
  };
}

describe("createFlatApiRoutes()", () => {
  test("resource", () => {
    const router = new TestApiRouter();
    expect(Object.keys(createFlatApiRoutes(router.routes))).toEqual([
      "/posts",
      "/posts/:id",
    ]);
  });
});
