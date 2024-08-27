# Routing
View and api routes are defined separately

## View routes

1. **Basic view route**
```ts
// app/http/router/view.ts


```

2. **View route with server data**
a. Using callback handler
```ts
// app/http/router/view.ts


```

b. Using controllers
```ts
// app/http/router/view.ts


```

3. **Layouts**
```ts
// app/http/router/view.ts


```

3. **Nested view routes**
```ts
// app/http/router/view.ts


```

## Api routes

1. **Using callback handler**
```ts
// app/http/router/api.ts


```

2. **Using controllers**
```ts
// app/http/router/api.ts


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


3. 

## Middleware
Note: middlewares are work exacly the same for view and api routes

1. **Route level middleware**
```ts
// app/http/router/api.ts


```

2. **Router level middleware**
```ts
// app/http/router/api.ts


```


## Client side routing

1. **Declarative navigation using `Link` component **

```tsx


```

a. Styling active links
```tsx
<Link href="/products/:productId'" search={{}} params={{}} />

```



2. **Imparative navigation using `useNavigate` hook **
```tsx


```

3. **Reading and updating url search parameters using `useSearchParams` hook **
```tsx


```

4. **Accessing current route path and parameters using `useRoute` hook ** 
```tsx


```
