# Routing
View and api routes are defined separately

## View routes

First argument is the view name and the second argument is the handler callback function or controller, method tuple

1. **Basic view route**
```ts
// app/http/router/view.ts
export default class extends ViewRouter {
  routes = {
    '/': this.view('Home')
  }
}
```

2. **View route with server data**

Data handlers return an object that will be passed to the view as props

a. Using callback handler
```ts
// app/http/router/view.ts

export default class extends ViewRouter {
  routes = {
    '/': this.view('Home', (req, res) => {
      return  return { name: 'John' }
    })
  }
}

```

b. Using controllers
```ts
// app/http/router/view.ts

export default class extends ViewRouter {
  routes = {
    '/': this.view('Home', [HomeController, 'index'])
  }
}

```

3. **Layouts**

ViewRouter.layout takes a layout name as a first argument and a callback function or controller, method tuple as second argument and child routes as a third argument.

The second argument can also be child routes instead of a callback function or controller, method tuple

Example layout without data handler
```ts
// app/http/router/view.ts

export default class extends ViewRouter {
  routes = {
    '/': this.layout('Layout', {
      '/': this.view('Home'),
      '/about': this.view('About')
    })
  }
}

```

Example layout with data handler
```ts
// app/http/router/view.ts

export default class extends ViewRouter {
  routes = {
    '/': this.layout('Layout', [HomeController, 'index'], {
      '/': this.view('Home'),
      '/about': this.view('About')
    })
  }
}
```


## Api routes

1. **Using callback handler**
```ts
// app/http/router/api.ts

export default class extends ApiRouter {
  routes = {
    '/': this.get(async (req: HttpRequest) => {
      return { name: 'John' }
    })
  }
}

```

2. **Using controllers**
```ts
// app/http/router/api.ts
export default class extends ApiRouter {
  routes = {
    '/': this.get(HomeController, 'index')
  }
}
```



## Dynamic routing

> NOTE: Works in the same way in both view and api routes

1. Using parameters 
```ts
// app/http/router/api.ts

class ProductRouter extends ApiRouter {
  routes = {
    '/product/:productId': this.put(ProductController, 'update')
  }
}

```

2. Using optional parameters 
```ts
// app/http/router/api.ts

class ProductRouter extends ApiRouter {
  routes = {
    '/product/:productId?': this.put(ProductController, 'update')
  }
}

```




## Nested routes

View router example
```ts
// app/http/router/view.ts

class ProductRouter extends ViewRouter {
  routes = {
    '/': this.view('ProductList'),
    '/:productId': this.view('ProductDetails'),
  }
}

export default class extends ViewRouter {
  routes = {
    '/product': ProductRouter
  }
}

```

Api router example
```ts
// app/http/router/api.ts
class ProductRouter extends ApiRouter {
  routes = {
    '/': this.get(ProductController, 'index')
    '/:productId': this.get(ProductController, 'show')
  }
}

export default class extends ApiRouter {
  routes = {
    '/product': ProductRouter
  }
}

```

## Middleware
Note: middlewares are work exacly the same for view and api routes

1. **Route level middleware**
```ts
// app/http/router/api.ts

class ProductRouter extends ApiRouter {
  // only authenticated users can access this route
  middlewares = ['auth']

  routes = {
    '/': this.get(ProductController, 'index')
  }
}

export default class extends ApiRouter {
  routes = {
    '/product': ProductRouter
  }
}

```

2. **Router level middleware**
```ts
// app/http/router/api.ts

export default class extends ApiRouter {
  routes = {
    // everyone can access this route
    '/product': this.get(ProductController, 'index'),
    // only authenticated users can access this route
    '/product/:productId': this.get(ProductController, 'show').middleware('auth')
  }
}

```

