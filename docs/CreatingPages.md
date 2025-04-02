# Creating pages and layouts

First create a react component exported as default from a file in `app/views` directory. 

```tsx
// app/views/Home.tsx
export default function Home() {
  return (
    <div>
      <h1>Home</h1>
    </div>
  );
}
```


Then define with route will render that component in the `app/http/routes/view.ts` file.

```typescript
import { ViewRouter } from 'gemi/http'

export default class extends ViewRouter {
  routes = {
    '/': this.view('Home')
  }
}
```

`Home` as string passed to the `this.view` here is the name of the file relative to the `app/views` directory.

## Passing data to your components

The `view` method from `ViewRouter` accepts a second argument as a handler and what's being returned from the handler will be passed to the view component as a prop.

```typescript
import { ViewRouter } from 'gemi/http'

export default class extends ViewRouter {
  routes = {
    '/': this.view('Home', () => {
      return {
        title: 'Home'
      }
    })
  }
}
```

Additionally you can type the props of your react component using `ViewProps` type. It will infer the data type being returned from the handler for the given route.

```tsx
// app/views/Home.tsx
import { type ViewProps } from 'gemi/client'

export default function Home(props: ViewProps<'/'>) {
  const title = props.title; // props is now type-safe
  return (
    <div>
      <h1>{title}</h1>
    </div>
  );
}
```

In the route handler function you can access to your database, or fetch data from external resources and pass it to your view component. 

In the first request, the react component will be rendered on the server and the subsequent requests will be handled on the client side like an SPA. The router will make a request to the server to fetch the server data and load the JS file required for the react component in parallel. Then when both requests are fullfilled the router will render the react component with the server data and finish the navigation.

## Dynamic routes

When you have a page rendered on a route with a dynamic segment in the url (e.g `/orders/1234-abcd`) you can define your route and access to the dynamic part in the handler function like in following example.

```typescript
import { ViewRouter } from 'gemi/http'

export default class extends ViewRouter {
  routes = {
    '/orders/:orderId': this.view('OrderDetail', (req: HttpRequest) => {
      const order = await db.orders.findOne({ where: { id: req.params.orderId } })
      return { order }
    })
  }
}
```
