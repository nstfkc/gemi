# Creating pages, layouts and navigation between them

Gemi implements a code based router where you can define all of your routes within `ViewRouter` class in `view.ts` file under `/app/http/routes`. 

> A `view.ts` file will be created for you after you initialized your project.

Config based router has 2 main benefits:
1. The route types (paths, route parameters and server data) can be inferred and provides type-safe navigation and page components.
2. For applications with too many pages it is easier to maintain compared to a file-system router

You can split your routes into different routers and compose them in the root router, protect your routes with middleware either in route or router level, group your routes and create nested routes with layouts.

Here is an example showcasing everything you can do;

```tsx
// app/http/routes/view.ts

import { ViewRouter, HttpRequest } from 'gemi/http';

// This is your root router, which is the entry point for all your routes.
// It will be created automatically when you initialize your project
export default class extends ViewRouter {
  // 1. You can define your middleware using `middlewares` property
  // `cache` is the alias of the middleware, the rest after `:` are the parameters for this middleware
  // This middleware is to control how long your pages will be cached
  // you can adjust the duration based on your needs.
  middlewares = ["cache:public,12840,must-revalidate"];

  routes = {
    // This is how you create layouts, all the routes defined as a children
    // will be rendered inside `PublicLayout` component
    "/": this.layout("PublicLayout", {
      // The first argument of the `view` method is the pathname of the component
      // relative to the `/app/views` directory.
      "/": this.view("Home"),
      // The second argument is a callback function
      // It will run on the server and what it returns 
      // will be passed to your view components via props
      "/about": this.view("About", () => {
        return { title: "About" };
      }),
      // The callback function takes a `HttpRequest` that will be passed
      // by the router when the pages is being requested
      // You can access to your search parameters, cookies and headers etc.
      // If you want to set cookies, you can use `req.ctx().setCookie`
      // and `req.ctx().deleteCookie` to delete them
      "/pricing": this.view("Pricing", (req: HttpRequest) => {
        const campaignId = req.search.get('campaign-id');
        const cookie = req.cookies.get("cookieName");
        const header = req.headers.get("headerName");
        // set a cookie
        req.ctx().setCookie("cookieName", "cookieValue", { httpOnly: true });
        // you can call this multiple times
        req.ctx().setCookie("otherCookieName", "otherCookieValue", { httpOnly: true });
        // You can also delete cookies
        req.ctx().deleteCookie('access_token')
        return { title: "Pricing", campaignId };
      }),
    }),
    // You can split your routes into different routers and compose them
    // Every route in this route will start with `/auth`
    "/auth": AuthRouter,
    // If you don't want to use a route prefix, you can use `(groupName)` annotation
    // This is useful when you want to use the same root route with other routes
    // but with additional middleware
    "(app)/": AppRouter,
  };
}

class AuthRouter extends ViewRouter {
  // Child routes inherits their parent router's middleware
  routes = {
    // This route will render a component default exported from `/app/views/auth/SignIn.tsx`
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
    "/reset-password": this.view("auth/ResetPassword"),
    "/forgot-password": this.view("auth/ForgotPassword"),
  };
}

class AppRouter extends ViewRouter {
  // In your child routes you can override a middleware defined 
  // `auth` middleware will prevent users without authentication to access to the routes
  // defined in this router, and child routers as well.
  middlewares = ["auth", "cache:private"];
  routes = {
    "/": this.layout("AppLayout", {
      // 1. You can also use `Controllers` to handle your routes business logic.
      // 2. You need to pass a tuple, first item will be the Controller class
      // and the second item will be the name of the method that handles the route's business logic
      // 3. It is completely fine to use callback handlers if you don't like controllers,
      // But you can't define the callback function outside of the router
      // Otherwise you won't be able to access to the request.
      "/dashboard": this.view("app/Dashboard", [AppController, 'dashboard']),
      // 1. You can have nested layouts
      // 2. You can use controllers or callback handlers
      // to load data for your layouts on the server
      "/orders": this.layout('app/OrdersLayout', [OrdersController, 'layout'], {
        "/": this.view("app/Orders", [OrderController, 'index']),
      }),
      // To create dynamic url segments, put `:` in front of the segment
      // to make it optional add `?` to the end e.g `/:orderId?`
      "/orders/:orderId": this.view("app/OrderDetail", async (req: HttpRequest) => {
        // You can access to the dynamic segments using `req.params`
        // The name of the parameter will be the name after `:`
        const orderId = req.params.orderId
        // then you can use the `orderId` to query your database
        return {}
      }),
      // You can apply middlewares in route level
      // Note: `role` middleware doesn't exist, but you can implement it by yourself
      "/admin": this.view('app/Admin').middleware(['role:admin']),
    }),
    // Somehow if you find yourself in a situation where you need to 
    // disable a middleware for a route you can 
    // This will remove the `auth` middleware defined in the router
    "/public": this.view('app/Public').middleware(['-auth']) 
  };
}

/*

Additional info
1. Built in middlewares are `cache`, `auth`, `cors`, `csrf`, `rate-limit`
1a. You can built your own custom middlewares see [Middleware](https://github.com/nstfkc/docs/Middleware.md) documentation.
2. You don't need to use `csrf` and `cors` middlewares for your view routes. Those are meant to use in api routes

Best practices
1. You should use controllers to handle the business logic for your routes
this will make your router code cleaner, and it will make it easey to find your
way when you have too many routes

2. Avoid creating deeply nested routes, it will make it hard for you to make sense out of your routes.

3. Use `cache:private` middleware for your protected routes otherwise you can have stale data in your views.

4. When you use a CDN, configure it in a way that it respects the cache headers returned from the origin.
 */

```

If you think you are good to go, you can jump into [navigation](##navigation) docs. Or continue to read if you need more explanation.

