# Creating Pages

Gemi implements a code-based router where you define all your routes within the `ViewRouter` class in the `view.ts` file under `/app/http/routes`.

> A `view.ts` file will be created for you automatically when you initialize your project.

The code-based router offers two main benefits:
1. Route types (paths, route parameters, and server data) can be inferred, providing type-safe navigation and page components
2. Applications with many pages are easier to maintain compared to a file-system router

## Basic Routing

Let's start with a simple route definition:

```tsx
// app/http/routes/view.ts
import { ViewRouter } from 'gemi/http';

export default class extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/about": this.view("About"),
    "/contact": this.view("Contact")
  }
}
```

The first argument of the `view` method is the component path relative to the `/app/views` directory. For example, the route `/about` will render a component exported as default from `/app/views/About.tsx`.

## Using Layouts

Layouts allow you to share UI elements (like navigation bars and footers) across multiple routes:

```tsx
export default class extends ViewRouter {
  routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home"),
      "/about": this.view("About"),
      "/contact": this.view("Contact")
    })
  }
}
```

All routes defined as children will be rendered inside the `PublicLayout` component.

You can also nest layouts:

```tsx
export default class extends ViewRouter {
  routes = {
    "/app": this.layout("AppLayout", {
      "/dashboard": this.view("Dashboard"),
      "/orders": this.layout("OrdersLayout", {
        "/": this.view("Orders"),
        "/create": this.view("CreateOrder")
      })
    })
  }
}
```

## Dynamic Routes

To create dynamic URL segments, add a colon (`:`) before the segment name:

```tsx
export default class extends ViewRouter {
  routes = {
    "/users/:userId": this.view("UserProfile"),
    "/products/:category/:productId": this.view("ProductDetail")
  }
}
```

To make a segment optional, add a question mark (`?`) after the segment name:

```tsx
export default class extends ViewRouter {
  routes = {
    "/blog/:postId?": this.view("BlogPost")
  }
}
```

## Nesting Routers

Split your routes into multiple routers for better organization:

```tsx
export default class extends ViewRouter {
  routes = {
    "/": this.layout("PublicLayout", {
      // Public routes
    }),
    "/auth": AuthRouter,
    "/app": AppRouter
  }
}

class AuthRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
    "/reset-password": this.view("auth/ResetPassword")
  }
}

class AppRouter extends ViewRouter {
  middlewares = ["auth"];
  
  routes = {
    // Routes requiring authentication
  }
}
```

## Grouping Routes

If you don't want to use a route prefix but still want to group routes with specific middleware, you can use a route group annotation:

```tsx
export default class extends ViewRouter {
  routes = {
    "/": PublicRouter,
    "(admin)/": AdminRouter, // Routes in AdminRouter are accessible at the root path
    "(app)/": AppRouter      // Routes in AppRouter are accessible at the root path
  }
}
```

This ensures routes are accessible at the root (`/`) but have different middleware applied.

## Passing Server-Side Data Using Callback Functions

You can pass data to your components by providing a callback function as the second argument to the `view` method:

```tsx
export default class extends ViewRouter {
  routes = {
    "/about": this.view("About", () => {
      return { 
        title: "About Us", 
        description: "Our company history" 
      };
    }),
    
    "/team": this.view("Team", async () => {
      // You can also use async functions
      const teamMembers = await fetchTeamMembers();
      return { teamMembers };
    })
  }
}
```

The data returned from this callback will be passed as props to your view component.

## Passing Server-Side Data Using Controllers

For better organization, you can use controllers instead of inline callback functions:

```tsx
import { HomeController } from '@/app/http/controllers/HomeController';
import { ProductController } from '@/app/http/controllers/ProductController';

export default class extends ViewRouter {
  routes = {
    "/": this.view("Home", [HomeController, 'index']),
    "/products": this.view("Products", [ProductController, 'list']),
    "/products/:id": this.view("ProductDetail", [ProductController, 'show'])
  }
}
```

This approach passes a tuple where:
- The first item is the Controller class
- The second item is the name of the method that handles the route's business logic

You can also pass data to layouts using controllers:

```tsx
export default class extends ViewRouter {
  routes = {
    "/": this.layout("PublicLayout", [LayoutController, 'publicLayout'], {
      "/": this.view("Home", [HomeController, 'index']),
      "/about": this.view("About", [AboutController, 'index'])
    })
  }
}
```

## View components

All the view components are located in `app/views` directory. The first argument of `view` and `layout` method for `ViewRotuer` class is the path of the react component relative to the `app/views` directory. 

For example
```typescript
"/": this.view("Home")
```
The component will be rendered for this page is exported from `app/views/Home.tsx` file.

You can organize your view components under separate folders. Then you need to specify the full path relative to the `app/views` directory. Let's say your view component is exported from `app/views/user/profile/Settings.tsx` file. 

Then you should speficy it like
```typescript
"/user/profile/settings": this.view("user/profile/Settings")
```


> All view components are normal react components that you can use all the react hooks without any limitation.

> All view components needs to be exported as default

### Accessing server data from your view components

The data loaded on the server will be passed to your view componensts via props.

```tsx
// route definition
"/": this.view("Home", () => ({ title: 'Home' }))

// view component
import { type ViewProps } from 'gemi/client'

export default function Home(props: ViewProps<'/'>) {
  return <div>{props.title}</div>
}
```

`ViewProps` is a helper type allows you to infer the data type returned from your route handlers. It takes a route path as a parameter and your code editor will be able to show you all the routes when you autocomplete.

### Navigating between pages

#### Using `<Link>` component

`<Link>`component renders an html `<a>` under the hood and allows client-side navigation between your routes without refreshing your page. 

Basic usage:
```tsx
import { Link } from "gemi/client"

<Link href="/about">About</Link>
```

Dynamic parameters:
```tsx
import { Link } from "gemi/client"

<Link href="/blog/:slug" params={{ slug: 'hello-world'}}>Hello world</Link>
```

#### Using `useNavigate` hook

```tsx
const { push, replace } = useNavigate();

push('/about'); // Pushes a new entry to your history

replace('/dashboard') // Replaces the current entry

push('/blog/:slug', { params: { slug: 'hello-world' } })
```

## Redirects

### Server side

You can use `Redirect` facade in your server code to redirect to another page.

```typescript
import { Redirect } from "gemi/facades"

Redirect.to('/dashboard')
```

> Note: avoid wrapping `Redirect` with `try / catch` block, otherwise it's not going to work.

### Client side

You can use `Redirect` component to redirect to another page on client side.

```tsx
import { Redirect } from "gemi/client"

<Redirect to="/dashboard" />
```

## Using Middlewares

### Router-level Middleware

You can apply middleware to all routes within a router:

```tsx
export default class extends ViewRouter {
  middlewares = ["cache:public,12840,must-revalidate"];
  
  routes = {
    // All routes here will use the middleware
  }
}
```

### Route-level Middleware

Apply middleware to specific routes:

```tsx
export default class extends ViewRouter {
  routes = {
    "/admin": this.view('app/Admin').middleware(['role:admin']),
    "/reports": this.view('app/Reports').middleware(['auth', 'role:manager'])
  }
}
```

## Overriding Middlewares

You can disable inherited middleware for specific routes:

```tsx
export default class extends ViewRouter {
  middlewares = ["auth"];
  
  routes = {
    "/dashboard": this.view('Dashboard'),
    "/public": this.view('Public').middleware(['-auth']), // Removes auth middleware
    "/admin": this.view('Admin').middleware(['role:admin']) // Adds role middleware
  }
}
```

## Built-in Middlewares

Gemi provides several built-in middleware options:

- `cache`: Controls how long your pages will be cached
- `auth`: Protects routes from unauthorized access
- `cors`: Handles Cross-Origin Resource Sharing
- `csrf`: Protects against Cross-Site Request Forgery
- `rate-limit`: Limits request rates

Example:
```tsx
export default class extends ViewRouter {
  middlewares = ["cache:public,12840,must-revalidate", "auth"];
  
  routes = {
    // Routes here
  }
}
```

> Note: `csrf` and `cors` middleware are primarily meant for API routes, not view routes.

## Accessing Route Parameters and Search Parameters

### Route Parameters

You can access route parameters using the `params` property of the request object:

```tsx
"/users/:userId": this.view("UserProfile", (req: HttpRequest) => {
  // Access the dynamic segment using req.params
  const userId = req.params.userId;
  
  // Use the userId to fetch data
  return { userId };
})
```

### Search Parameters

Access query string parameters using the `search` property:

```tsx
"/search": this.view("Search", (req: HttpRequest) => {
  // Access query parameters from /search?q=something&page=2
  const query = req.search.get('q');
  const page = req.search.get('page');
  
  return { query, page };
})
```

## Setting and Deleting Cookies

You can set and delete cookies using the request context:

```tsx
"/login": this.view("Login", (req: HttpRequest) => {
  // Set a cookie
  req.ctx().setCookie("theme", "dark", { 
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30 // 30 days
  });
  
  // Set another cookie
  req.ctx().setCookie("lastVisit", new Date().toISOString());
  
  // Delete a cookie
  req.ctx().deleteCookie('temporary_token');
  
  return { success: true };
})
```

## Best Practices

1. **Use controllers for business logic**: This keeps your router code clean and easier to maintain

```tsx
// Good: Using controllers
"/products": this.view("Products", [ProductController, 'list'])

// Avoid: Complex callbacks in routes
"/products": this.view("Products", async () => {
  const products = await db.products.findMany();
  const categories = await db.categories.findMany();
  const featured = await db.products.findMany({ where: { featured: true }});
  // More complex logic...
  return { products, categories, featured };
})
```

2. **Avoid deeply nested routers**: Deep nesting can make routes difficult to understand

```tsx
// Bad: Deep nesting

class AppRouter extends ViewRouter {
  routes = {
    "/user": UserRouter,
  }
}

class UserRouter extends ViewRouter {
  routes = {
    "/": this.view("User"),
    "/profile": ProfileRouter
  }
}

class ProfileRouter extends ViewRouter {
  routes = {
    "/settings": this.view("Settings")
  }
}

// Good: Flat structure

class AppRouter extends ViewRouter {
  routes = {
    "/user": this.view("User"),
    "/user/profile": this.view("Profile"),
    "/user/profile/settings": this.view("Settings")
  }
}
```

3. **Use `cache:private` for protected routes**: This prevents stale data in authenticated views

```tsx
class AdminRouter extends ViewRouter {
  middlewares = ["auth", "cache:private"];
  
  routes = {
    // Protected routes with proper caching
  }
}
```

4. **Configure CDNs properly**: When using a CDN, make sure it respects cache headers from the origin

By following these guidelines, you'll create clean, maintainable, and type-safe routing for your application.

