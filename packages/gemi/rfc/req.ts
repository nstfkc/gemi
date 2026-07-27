class XRequest extends Request {}

class Default extends ApiRouter {
  routes = {
    "/x": this.get(XController, "index").with(XRequest),
  };
}
