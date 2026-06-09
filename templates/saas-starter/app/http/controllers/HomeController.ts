import { Controller } from "gemi/http";
import { Service } from "gemi/services";

class Bar extends Service {
  bar() {
    console.log("bar");
  }
}

class Foo extends Service {
  constructor(private bar = Bar.inject()) {
    super();
  }

  foo() {
    console.log("foo");
    this.bar.bar();
  }
}

export class HomeController extends Controller {
  constructor(private foo = Foo.inject()) {
    super();
  }

  async index() {
    this.foo.foo();
    return {};
  }
}
