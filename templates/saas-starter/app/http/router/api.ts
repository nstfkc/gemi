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

export default class extends ApiRouter {
  routes = {
    "/users": this.get(async () => {
      prisma.user.createMany;
      const users = await prisma.user.findMany();
      return {
        users,
      };
    }),
    "/users/:id": this.post(async (req: HttpRequest<{}, { id: number }>) => {
      return { params: req.params };
    }),
    "/test": TestRouter,

    "/file": this.post(TestController, "file"),
  };
}
