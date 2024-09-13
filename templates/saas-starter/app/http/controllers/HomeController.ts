import { Query, Redirect } from "gemi/facades";
import { Controller, HttpRequest } from "gemi/http";

export class HomeController extends Controller {
  public async about() {
    return { title: "EnesXxxx!!" };
  }

  public async index(req: HttpRequest<{ color: string }>) {
    Query.prefetch("/home", { search: req.search.toJSON() });

    const items = [
      { id: 1, name: "Red", hex: "#FF0000", color: "red" },
      { id: 2, name: "Green", hex: "#00FF00", color: "green" },
      { id: 3, name: "Blue", hex: "#0000FF", color: "blue" },
      { id: 4, name: "Yellow", hex: "#FFFF00", color: "yellow" },
      { id: 5, name: "Purple", hex: "#800080", color: "purple" },
    ];

    const filters = items.map((item) => item.color);
    const colors = items.filter((item) =>
      req.search.get("color")
        ? req.search.get("color").split(".").includes(item.color)
        : true,
    );
    return { colors, filters };
  }
}
