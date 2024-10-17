# Routing
Gemi comes with config based routing that allows you to define your application routes declaratively using `ViewRouter` class. Routers can be composed and comes with built in middleware support. Middlewares can be applied to a router or a route. You will learn more about this in [middlewares](#Middlewares) section.

## Basics

In a fresh project, you can find your root router in `app/http/router/view.ts` file. A very basic route can be defined like in the following code example.


```ts
// app/http/router/view.ts

export default class extends ViewRouter {

  routes = {
    '/': this.view('Home')
  }
}

```

`routes` property in `ViewRouter` class is where you define your routes. The keys are the pathname of your route and you can define which component will be rendered for the route by passing the component path relative to `app/views` directory to the `ViewRouter.view` method without the file extension. 

In this example, we define a route for the root path `/` that renders a component exported as default from `app/views/Home.tsx` file.

> 💡 View components has to be exported as default.

E.g `app/views/Home.tsx` file should look like this.

```tsx
// app/views/Home.tsx

export default function Home() {
  return <div>Hello world!</div>
}

```

> 💡 View components are rendered on the server as default for the initial request. You can not opt-out this behaviour. 

## Passing server data to your views

### Using callbacks

If you want to pass dynamic data to your components. You can pass a callback function as a second argument to the `ViewRouter.view` method. What you return from this callback function will be passed to your view component as a prop.

Let's expand the first examples and pass a dynamic data to the `Home.tsx` component.

```ts
// app/http/router/view.ts

export default class extends ViewRouter {

  routes = {
    '/': this.view('Home', () => {
      return { message: 'Hello world!' }
    })
  }
}

```


> 💡 The callback function that returns data, has to return an object, otherwise you can't access it from the component props.

Based on the update we made in the previous code block, we can change the `Home.tsx` component like following and use the data returned from the server.


> 💡 `view.ts` file is only executed on the server, external libraries or secrets you use in this file can't be leaked to the client. You can safely access to your database inside the callback function.

```tsx
// app/views/Home.tsx

export default function Home(props) {
  return <div>{props.message}</div>
}

```

 As you can see above, now we are able to access to the data returned from the callback function. But as you can imagine, the `props` here is not type-safe, to make the props typed based on what's being returned from the callback function, you can use `ViewProps` utility type to make your component props type-safe.
 
For example

```tsx
// app/views/Home.tsx

import { type ViewProps } from 'gemi/client'

export default function Home(props: ViewProps<'/'>) {
  return <div>{props.message}</div>
}

```

`ViewProps` type is a generic type, meaning you need to pass the route path you defined for this route inside the `view.ts` file. 

### Using controllers

For small projects, you can get away with only using callback functions for your routes. But as soon as your application starts to grow it becomes too cumbersome to manage all that. In that case you can use controllers to handle your data loading logic for your views.

Same as callback functions you can pass your controller class and the method name in a tuple as a second argument to the `ViewRouter.view` method.

For example if we update the previous example with the callback function in would look like following.

```ts
// app/http/router/view.ts
import { HomeController } from '@/app/http/controllers/HomeController'

export default class extends ViewRouter {

  routes = {
    '/': this.view('Home',[HomeController, 'home'])
  }
}
```

And the `HomeController.ts` file would look like this.

```ts
// app/http/controllers/HomeController.ts

import { Controller } from 'gemi/http'

export class HomeController extends Controller {
  home() {
    return { message: 'Hello world!' }
  }
}

```

You can find more detailed documentation in [Controllers]('https://github.com/nstfkc/gemi/blob/main/docs/Controllers.md') section. But for now it's good idea to mention that both callback handlers and controller methods can be async. These are the places where you can access to your database and side-effects like sending email, dispatching events etc.

## Layouts

If you want to share some UI between your routes (e.g navigation, footer etc.) you can use `ViewRouter.layout` method to achieve that. Layouts work exactly like views the only addition is you can pass your child routes as a second (or third if you use callback functions or controllers to fetch data for your layouts) argument.

For example;

```ts
// app/http/router/view.ts
import { HomeController } from '@/app/http/controllers/HomeController'

export default class extends ViewRouter {

  routes = {
    '/': this.layout('PublicLayout', {
      '/': this.view('Home',[HomeController, 'home'])
      '/about': this.view('About'),
      '/contact: this.view('Contact'),
    })
  }
}
```

In this example, we nested our routes under the "PublicLayout" component. Every component being rendered from these routes will be wrapped with the `PublicLayout` component.

Here is how the `PublicLayout` component would look like;

```tsx
// app/views/PublicLayout.tsx

import { type LayoutProps } from 'gemi/client'
import { Navigation } from '@/app/views/components/Navigation'
import { Footer } from '@/app/views/components/Footer'

export default function PublicLayout(props: LayoutProps<'/'>) {
  return (
    <>
      <Navigation />
      {props.children}
      <Footer />
    </>
  )
}

```

In the code snippet above, you see how to implement a layout component. `props.children` will be the component being rendered based on the url. If the url is the root url it will be the `Home.tsx` component, if the url is `/about` it will be the `About.tsx` component and so on.

> 💡 Just like the `ViewProps` utility type, you can use `LayoutProps` utility type to make your `props` type-safe for your layout component

You can also pass server data to your layouts like you do for your view routes either using callback functions or controllers and access them via `props` from your layout component. In this case, the child routes will be passed as a third argument.

For example using callback function would look like this
```
// app/http/router/view.ts
import { HomeController } from '@/app/http/controllers/HomeController'

export default class extends ViewRouter {

  routes = {
    '/': this.layout('PublicLayout', () => {
      return { title: 'My App' }
    }, {
      '/': this.view('Home',[HomeController, 'home'])
      '/about': this.view('About'),
      '/contact: this.view('Contact'),
    })
  }
}
```

Or like this if you use controllers

```
// app/http/router/view.ts
import { HomeController } from '@/app/http/controllers/HomeController'
import { PublicLayoutController } from '@/app/http/controllers/PublicLayoutController'

export default class extends ViewRouter {

  routes = {
    '/': this.layout('PublicLayout', [PublicLayoutController, 'index'], {
      '/': this.view('Home',[HomeController, 'home'])
      '/about': this.view('About'),
      '/contact: this.view('Contact'),
    })
  }
}
```


> 💡 When you navigate between the sibling routes of a layout, the server data for the layout will be persisted and the callback handler or controller method won't be invoked. Currently there is no mechanism to opt-out this behaviour but there will be a new API to handle such scenarios in the future.

## Composing routers



## Using middlewares

