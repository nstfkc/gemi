class Handler { }

class Route<Method, Path> {
  constructor(
    public method: Method,
    public path: Path,
  ) { }

  static get<Path, Output>(path: Path, _handler: Handler) {
    return new Route("GET", path);
  }
  static post<Path, Output>(path: Path, _handler: Handler) {
    return new Route("GET", path);
  }
}

class Router<const T> {
  constructor(public routes: T[]) { }

  static all<const T>(...routes: T[]) {
  }
}

function Stream<T>(_handler: () => T) {
  return new Handler();
}

const routes = {
  'GET:/test/foo': () => {},
  'POST:/test/chat': () => {}
}

export default Router.all(
  Route.get('/foo', () => { }),
  Route.post('/chat', Stream(async function*() {
    yield '1234'
  })),
  Route.page('/x', () => {
    return ''
  }, [
    Route.page('/y', () => { })
  ])
)

