import { prisma } from "@/app/database/prisma";
import { I18n } from "gemi/facades";
import { ApiRouter, Controller, HttpRequest } from "gemi/http";
import { Storage } from "gemi/storage";

class TestRouter extends ApiRouter {
  routes = {
    "/": this.post(() => {
      return {};
    }),
  };
}

class FileRequest extends HttpRequest<{ file: Blob }> {
  schema = {
    file: {
      "fileType:jsonx": "File must be a JSON",
      custom: (file: Blob) => {
        if (file.size > 500) {
          return I18n.translate("validation.fileTooLarge", {
            unit: "KB",
          });
        }
      },
    },
  };
}

class TestController extends Controller {
  requests = {
    file: FileRequest,
  };
  async file(req: FileRequest) {
    const input = await req.input();

    const file = input.get("file");
    return {
      type: file.type,
      size: file.size,
    };
  }
}

class TestRequest extends HttpRequest<{ id: number }> {
  schema = {
    test: {
      required: "asdasd",
    },
  };
  refine(input: {}) {
    return {};
  }
}

class FooController extends Controller {
  requests = {
    create: TestRequest,
  };

  async create(req: TestRequest) {
    return {};
  }
}

export default class extends ApiRouter {
  routes = {
    "/users": this.get(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return await prisma.user.findFirst();
    }),
    "/home": this.get(async () => {
      return {
        message: "Hello, World!",
      };
    }),
    "/test/:1234": this.post(FooController, "create"),
    "/test": TestRouter,

    "/file": this.post(TestController, "file"),
  };
}
