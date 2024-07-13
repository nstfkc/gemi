# Gemi
Batteries included full-stack MVC web framework with server side rendering and soft navigation

## Tech stack
- React (view layer)
- Bun (runtime and server)
- Vite (bundler)
- Prisma (database and orm)

## Motivation
Gemi, aims to be a Laravel (or Rails) equavalent framework for the JS ecosystem.

## Features
- Routing
- Server side rendering with streaming
- Soft navigation
- Image optimisations
- RPC for http and websockets
- JWT based multi-tenant authentication and authorization
- ORM and database migrations (based on prisma)
- Emails (based on react-email)
- Events (based on WebSocket)
- Job Queues
- Task scheduling (e.g cron jobs)
- Validations

- CMS (Plugin)
- Analytics (Plugin)
- A/B tests and feature flags (Plugin)

> Note: Gemi is currently developed in a private repo and the npm package is not publicly accessible, this repo only includes the documentation. We will open-source the repo and release the npm package when the v0.1.0 is ready. Following documentation is not final, any feedback will be greatly appreciated. Please create an issue for your suggestions.

## Getting started

### Prerequisites

Gemi is built on top of [bun](https://bun.sh). Bun needs to be installed on your computer to be able to use `gemi`. 

Install bun

Linux & macOS

```
curl -fsSL https://bun.sh/install | bash
```

Windows

```
powershell -c "irm bun.sh/install.ps1 | iex"
```

### Installation

After you install bun, you can now run

```
bunx create-gemi-app
```

After the prompts `create-gemi-app` will create a folder with your project name and install dependencies.

## Basics

### Directory structure

├── app
│   ├── emails
│   ├── http
│   │   ├── controllers
│   │   ├── middlewares
│   │   ├── router
│   │   │   ├── api.ts
│   │   │   ├── view.ts
│   ├── views
│   │   ├── RootLayout.tsx
│   ├── app.css
│   ├── bootstrap.ts
│   ├── client.tsx
├── public
│   ├── favicon.ico
│   ├── customfont.ttf
│   ├── images
├── package.json


### Routing

Gemi comes with a declarative router where you use `ViewRouter` or `ApiRouter` classes to declare your routes. On the initial load the page is rendered on the server, after that client router takes over and works like an SPA.

#### Creating your first page

The simplest way to create a view route looks like this.

```ts
// app/router/view.ts

import { ViewRouter } from 'gemi/http'

export default class extends ViewRouter {

  routes = {
    '/': this.view('Home')
  }
}

```

`.view` method takes a string of a component path without the extension relative to the `app/views` directory. To make this example work, you need to have a component exported as default from `app/views/Home.tsx` file.

#### Client side routing

If you want to navigate between two pages you can either use built in `Link` component or `useRouter` hook.

```tsx

import { Link } from 'gemi/client'

export const Navigation = () => {
  return (
    <nav>
      <Link href="/">Home</Link>
      <Link href="/about">About</Link>
    </nav>
  )
}

```

```tsx
import { useRouter } from 'gemi/client'

export const CallToAction = () => {
  const { push } = useRouter()
  return (
    <button onClick={() => push('/contact')}>Call to action</button>
  )
}

```

### Views

Views are normal React components. You can name them however, and they can be placed in any depth in the `views` folder. The only exception is if you want to use a react component as a page, you need to export them as default. E.g

```
const Home = () => {
  return (
    <div>Hello world!</div>
  )
}

export default Home
```

### Loading data on the server and passing them to the view component

`ViewRouter.view` method accepts a callback function as a second argument where you can access to your database and what you return from that function will be passed to your view component as a prop.


E.g

```ts
// app/router/view.ts

import { ViewRouter } from 'gemi/http'

export default class extends ViewRouter {

  routes = {
    '/': this.view('Home', async () => {
      const posts = await db.posts.findAll();
      
      return { posts }
    })
  }
}

```

Then you can access to the `posts` via props of your view component.

```

import { Post } from './components/Post'

const Home = (props) => {
  const { posts } = props;
  return (
    <div>
      {posts.map(post => <Post key={post.id} post={post} />)}
    </div>
  )
}

export default Home
```

While this approach is good for prototyping and trying things out, it is better to use a `controller` to handle data fetching logic to keep everything organized.

Alternatively, you can pass a controller and method tuple as a second argument to `ViewRouter.view` method. E.g.

```ts
// app/router/view.ts

import { ViewRouter } from 'gemi/http'
import { HomeController } from '@/app/http/controllers/HomeController'

export default class extends ViewRouter {

  routes = {
    '/posts': this.view("Posts", [PostController, 'index'])
  }
}

```

```ts
// app/http/controllers/PostController.ts

import { Controller } from 'gemi/http'
import { db } from '@/app/db'

export class PostController extends Controller {
  async index() {
    const posts = await db.posts.findAll();
    
    return { posts }
  }
}

```

#### Creating your first api endpoint

`ApiRouter` class provides you `get`, `post`, `put`, `patch` and `delete` methods which you can limit access to your endpoint with certain http methods. A simplest way to create a `get` endpoint would look like this.

```ts

// app/http/router/api.ts

import { ApiRouter } from 'gemi/router'

export default class extends ApiRouter {

  routes = {
    '/posts': this.get(async () => {
       const posts = await db.posts.findAll();
    
       return { posts } 
    })
  }
}

```

> Note: Api routes are automatically prefixed with `/api`.

Again, you can use `controllers` to handle your business logic to keep things organized. E.g.


```ts
// app/http/controllers/PostController.ts

import { Controller } from 'gemi/http'
import { db } from '@/app/db'

export class PostController extends Controller {
  async list() {
    const posts = await db.posts.findAll();
    
    return { posts }
  }
}

```

### Data fetching and mutations

Gemi provides two hooks for data fetching and mutations, `useQuery` and `useMutation`.

```ts

const { data, loading, error } = useQuery('/posts');

const { trigger } = useMutation('/posts', { method: "POST" })

trigger({
  body: 'Hello world!'
})
```

### Forms and validations

Gemi comes with a built-in form components to make a request to your apis and handle validations.

```tsx
import { useState } from 'react'
import { Form, Input, TextArea, ValidationError } from 'gemi/client'

export const ContactForm = () => {
  const [isSuccessful, setIsSuccessful] = useState(false)
  if(isSuccessful) {
    return <div>Thank you! We have received your message!</div>
  }
  return (
    <Form action="/contact-form" method="POST" onSuccess={}>
      <div>
        <label htmlFor="email">Email</label>
        <Input type="email" name="email" id="email" />
        <ValidationError name="email" />
      </div>
      <div>
        <label htmlFor="message">Message</label>
        <Textarea name="message" id="message" />
        <ValidationError name="message" />
      </div>
      <button>Send</button>
    </Form>
  )
}
```

`ValidationError` components will be rendered if server returns a validation error associated with the respective field.

Gemi provides built in server side validation, you can validate the requests hit to your endpoints using `HttpRequest` class. E.g.

```ts
// app/http/controllers/PostController.ts

import { Controller, HttpRequest } from 'gemi/http'

class CreatePostRequest extends HttpRequest {
  schema = {
    'email': {
      'email': "Not a valid email",
      'required': 'Email is required'
    },
    'message': {
      'min:100': "Message is too short"
    }
  }
}

export class PostController extends Controller {
  requests = {
    create: CreatePostRequest
  }

  async create(req: CreatePostRequest) {
     const input = await req.input();
     const body = input.toJSON();
     
     //...
  }
}

```
 
If the request body fails the validation, the request will be terminated and it will return `400 Bad Request` status and the validation errors.



## Deep dive

### Routing

Gemi provides two router classes (`ViewRouter` and `ApiRouter`) to define your view and api routes separately. Both router classes are composable and can be split into different files. 

In a fresh project, you will find a `RootViewRouter` for your view routes and a `RootApiRouter` for your api routes in `/app/http/routes` directory.

You can define your routes by adding a new entry to the `routes` property in both routers. They keys represents the urls segments and the values represents the handler logic.

#### View routes

The most basic view route definition is passing a view name to the `view` method. View names are the file path and the names relative to the `app/views` directory without the extension. For example, if you have a react component in `/app/views/Home.tsx` you can create a route like in the the following example.

```ts
// app/http/routes/view.ts

import { ViewRouter } from 'gemi/http'

export default class extends ViewRouter {

  routes = {
     '/': this.view('Home')
  }
}
```


If you want to pass data to your react component, you can pass a function as a second argument to the `view` method and in that function you can access to your database and return data to be passed to your react component.

e.g

```ts
// app/http/routes/view.ts

import { ViewRouter } from 'gemi/http'

export default class extends ViewRouter {

  routes = {
     '/': this.view('Home', async (req) => {
        // here you can fetch data from the database
        // or extract data from the request and pass it to the view.
        return { data: { message: 'Hello world' }}
     }),
  }
}
```

You access to the data passed from the server via your component's props.

```tsx
// app/views/Home.tsx

export default function Home(props: { message: string}) {
  return <div>{props.message}</div>
}
```

As you can imagine this approach can get messy when your application logic grows. To keep your router files organized, you can use `Controllers` to handle your business logic for your routes.
 
You can pass a controller and a method name that exist in that controller in a tuple as a second argument to the `view` method. Like in the first example, what is being returned from the controller method will be passed to the react component that is located in the first argument.

E.g
```ts
// app/http/routes/view.ts

import { ViewRouter } from 'gemi/http'
import { HomeController } from '@/app/http/controllers/HomeController'

export default class extends ViewRouter {

  routes = {
     '/': this.view('Home', [HomeController, 'index']),
  }
}

```


**Nested view routes**

If you want to share componets (header, footer etc.) between your routes, you can use `ViewRouter.layout` method like in the following example.

```ts
// app/http/routes/view.ts

import { ViewRouter } from 'gemi/http'


export class RootViewRouter extends ViewRouter {

  routes = {
     '/': this.layout('Layout', {
       '/': this.view('Home'),
       '/pricing': this.view('Pricing'),
       '/contact': this.view('Contact'),
     })
  }
}
```

If you want to pass a dynamic data to your layout components, you can pass a callback function or a `Controller` and method name as a second argument.

```ts
this.layout('Layout', [LayoutController, 'layout'], {
  '/': this.view('Home'),
  '/pricing': this.view('Pricing'),
  '/contact': this.view('Contact'),
})
``` 

And your `Layout` component would look like this.

```tsx
// app/views/Layout.tsx
import { Header } from './components/Header'
import { Footer } from './components/Footer' 

export default function AppLayout(props: { children: ReactNode }) {

  return (
    <div>
      <Header />
      {children}
      <Footer />
    </div>
  )
}

```

When you navigate between the child routes of a `layout`, the data you fetch for the Layout component will be cached in the browser and the `Layout` component won't be re-rendered.

If that's not what you want, you can use the `ViewRouter.view` method in a same way but differently all the data you fetch for your views will be re-fetched when you navigate between the child routes. To make the navigation snappy, the data for your routes will be fetched using "stale while revalidate" method.


E.g
```ts
{
  '/': this.view('Root', [RootController, 'index'], {
    '/foo': this.view('Foo', [FooController, 'index'], {
      '/bar': this.view('Bar', [BarController, 'index'])
    })
  })
}

```

Note: All the data fetching for the nested routes handled in parallel. Based on the given example above. When you navigate to `/foo` `RootController.index` and `FooController.index` will be called then if you navigate to `/foo/bar` `RootController.index`, `FooController.index` and `BarController.index` will be called. 


#### Api routes

**Basic usage**

```ts
// app/http/routes/api.ts

import { ApiRouter } from 'gemi/http'
import { OrderController } from '@/app/http/controllers/OrderController'

export default class extends ApiRouter {

  routes = {
    '/orders': this.get(OrderController, 'list'),
  }
}
```

Note: All api routes defined in the root level are automatically prefixed with `/api`. For this example you can access to the order list endpoint via `GET:/api/orders`

If you are folling REST API specification, you might want to handle multiple methods in the same url. In this case you can pass an array of handlers.

For example;

```ts
// app/http/routes/api.ts

import { ApiRouter } from 'gemi/http'
import { OrderController } from '@/app/http/controllers/OrderController'

export default class extends ApiRouter {

  routes = {
    '/orders': [
      this.get(OrderController, 'list'),
      this.post(OrderController, 'create')
    ],
    '/orders/:orderId': [
      this.get(OrderController, 'show'),
      this.put(OrderController, 'update'),
      this.delete(OrderController, 'delete'),
    ],
  }
}
```

For this specific case you can use a ResourceController (more on this later) to define all the REST routes. A resource contoller has to have `list`, `create`, `show`,`update` and `delete` methods.

```ts
// app/http/routes/api.ts

import { ApiRouter } from 'gemi/http'
import { OrderController } from '@/app/http/controllers/OrderController'

export default class extends ApiRouter {

  routes = {
    '/orders': OrderController
  }
}
```

**Route parameters**

Gemi uses [URL Pattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) to resolve the matching routes based on the url. 

You can define a url parameter by prefixing the url segment with ':' e.g `/orders/:orderId` and you can suffix the dynamic segment with '?' to make it optional e.g `/orders/:orderId?`

For more examples check out the URL Pattern API documentation.

In your controllers you can access to the parameters via `request.parameters` 

Examples;
```ts

export default class extends ViewRouter {
  '/orders': this.view('OrdersOverview', [OrdersController, 'overview']),
  '/orders/:orderId': this.view('OrderDetails', [OrdersController, 'details']),
  '/orders/:orderId/customer/:customerId?': this.view('OrderCustomerDetails', [OrdersController, 'customerDetails']),
}

```

#### Router composition

For complex apps with a lot of routes, it would be pretty messy to handle all the routes in a single file. You can compose your routers like following example;

```ts
// app/http/routes/api.ts

import { ApiRouter } from 'gemi/http/ApiRouter'
import { OrderApiRouter } from './OrderApiRouter'
import { ProductApiRouter } from './ProductApiRouter'

export default class extends ApiRouter {

  routes = {
    '/orders': OrderApiRouter,
    '/products': ProductApiRouter,
  }
}
```

This works for the view routes as well.


#### Protecting the routes

You can protect your routes using built in `AuthMiddleware`. Auth middleware works same for both `ApiRouter` and `ViewRouter`. If an unauthenticated user tries to access to protected routes;

If its a view route, server redirects the user to the sign in page.

If its an api route, server returns a json response with `401 Unauthorized Access` status code. 

```ts
// app/http/routes/view.ts

import { ViewRouter } from 'gemi/http/ViewRouter'
import { OrderController } from '@/app/http/controllers/OrderController'
import { DashboardController } from '@/app/http/controllers/DashboardController'

class AppViewRouter extends ViewRouter {
   middlewares = ['auth']

   routes = {
     '/': this.layout('AppLayout', {
        '/': this.view('Dashboard', [DashboardController, 'home']),
        '/orders': this.view('OrdersOverview', [OrderController, 'overview']),
        '/orders/:orderId': this.view('OrderDetails', [OrderController, 'details']),
        // ...
     })
   }
}

export default class extends ViewRouter {

  routes = {
     '/': this.view('Home'),
     '/pricing': this.view('Pricing'),
     '/contact': this.view('Contact'),

     // Only authenticated users can access to the routes defined in AppViewRouter
     '/app': AppViewRouter
  }
}

```

You can also define middlewares in route level using calling `.middleware` after the route definition e.g `this.view(...).middlewares(['auth'])`. 

Let's say you only want to allow admins to be able to access to certain pages;

```ts
class AppViewRouter extends ViewRouter {
   middlewares = ['auth']

   routes = {
     '/': this.layout('AppLayout', {
        '/': this.view('Dashboard', [DashboardController, 'home']),
        '/orders': this.view('OrdersOverview', [OrderController, 'overview']),
        '/orders/:orderId': this.view('OrderDetails', [OrderController, 'details']),

        // Only admins can access to this route
        '/organization': this.view('Organiszation', [OrganizationController, 'home']).middlewares(['role:ADMIN'])
        // ...
     })
   }
}
```

> Middlewares work exactly the same for the view routes. 

### Controllers

Controllers are where you define your application's business logic like accessing your database, dispatching events, queuing jobs. 

Note: You can use the same controller in both view and api routes. 

A simple controller would look like this;

```ts
// app/http/controllers/OrderController.ts

import { Controller } from 'gemi/http/Controller';

export class OrderController extends Controller {
  async list(request: HttpRequest) {
    const orders = await prisma.orders.findMany();
    return {
      data: { orders }
    }
  }
}

```

#### Authorization

You can access to the authenticated user by using `Auth` facade. 

```ts
// app/http/controllers/OrderController.ts

import { Controller } from 'gemi/http/Controller';
import { Auth } form 'gemi/facades/Auth';

export class OrderController extends Controller {
  async create(request: HttpRequest) {
    const user = await Auth.user();

    // rest of your business logic
    //...
  }
}

```

You don't have to wrap `await Auth.user()` in a try/catch block, If this call fail, for the api routes it will return an error message with `401 Unauthorized` status code and for view routes it will automatically redirect the user to the sign in page.



### Emails

#### Defining email templates

```tsx
// app/emails/WelcomeEmailTemplate.tsx

import { Html, Button, Text, Heading } from "@react-email/components";
import { EmailTemplate } from 'gemi/email

export class WelcomeEmail extends Email {
   subject = 'Welcome to Gemi'
   from = 'hi@gemi.dev'
   

   render(props: { username: string }) {
     return (
       <Html lang="en">
         <Heading>Welcome<Heading>
         <Text>{props.username}</Text>
       <Html>
     )
   }
}

```

#### Sending emails


```ts
import { Email } from 'gemi/email' 


Email.send(WelcomeEmailTemplate, { data: { username: 'johndoe' } })

```


### Broadcasting (Concept - Not implemented)

```ts

class Broadcasting implements IBroadcasting {
  channels = {
    '/order/created': OrderCreatedEvent
  }
}

export class OrderCreatedChannel extends BroadcastingChannel<OrderCreatedChannelArgs> {

  // Prepare what is being sent to the client
  async payload() {
    return { order: this.args.order }
  }
}

Broadcast('/order/created', { order });
```

### Jobs (Concept - Not implemented)


```ts

export class PrepareCSVJob extends Job {
  handle() {}
  onStarted() {}
  onFinished() {}
  onErrored() {}
  onCancelled() {}
}

Queue(PrepareCSVJob, { ...args })

```

### Scheduling tasks













