
Gemi is a batteries included full-stack web framework built on top of Bun and React. What makes Gemi unique is that it's the only web framework combines rich backend feature set with first class React integration. You can imagine a combination of Laravel backend and next.js frontend but everything is tightly integrated and you use the same language on both ends.

## Before you start

Gemi is an highly opinionated framework it comes with a lot constraints, it designed to work without needing external libraries and 3rd party services as much as possible. For example, you don't need to use an authentication or data-fetching library. You technically can but it is not advised.

Gemi requires a long running http server to operate, it means it will not work in a serverless environment and since it's built on top of Bun internals, it also only works with Bun runtime.

Gemi is written in TypeScript and only available in TypeScript. 

Gemi is built on top of React 19 but it doesn't support server components or server actions because they are not compatible with the architecture.

Gemi uses a declarative routing system where you define your routes with code. This allows you to implement complex middleware logic in route group or a route level and have type-safe navigation and data fetching without running any sort of code generation. 

Gemi uses MVC design pattern, controllers are where you define your business logic, authorize and validate requests, query your database, set/read cookies, send emails, dispatch async jobs etc. and views are where you define your UI using the data returned from your controllers.

> Model layer is currently outsourced using prisma, eventually there will be a native ORM implementation

## Features

Gemi is using SSR the first request then switch to client render on navigation rendering strategy. All of your favorite UI libraries and tailwindcss are supported.

#### Authentication
Gemi comes with built-in session based multi-tenant authentication API that supports sign in with email/password, magic links and OAuth. 
```tsx
<Link href="/auth/oauth/google">Continue with Google</Link>
```

#### Authorization
You can protect your pages and api endpoints using built in middleware and helpers

```ts
const user = await Auth.user()
```

#### Emails
You can send emails using your favorite email provider (built on top of jsx-email). Comes with resend as default provider but you can easily implement your own.

```ts
WelcomeEmail.send({ to: ["john@example.com"], data: {name: "John Doe"} })
```
#### Object storage
You can store your documents, images using built in S3 compatible API. If you just need to store a couple of files you can just use default file system driver.

```ts
const url = await FileStorage.put(file)
```

#### Asynchronous jobs
When you have some business logic that takes some time to run, you can run them behind the scenes. If you want to utilize all of your CPU cores, that's possible too.

```ts
class ProcessVideo extends Job {
  worker = true // Run in a worker 

  run({ videoId }) {}

  onSuccess() {}
  onFail() {}
}

ProcessVideo.dispatch({ videoId })
```

#### Type-safe data fetching and mutations
Gemi comes with built-in `useQuery` and `useMutation` hooks and `Form` component. All of the inputs and data types inferred automatically from your route definitions.
```tsx
export default function Posts() {
  const { data } = useQuery('/posts');
	// the first argument of `useQuery` is type-safe only accepts valid endpoints
    // data is typed as whatever type return from the controller

  const { trigger } = useMutation('POST', '/posts');
  // trigger is a function that takes the input defined defined for this request

  //...
}

```

#### Type-safe navigation

Gemi comes with built in `useNavigate` hook and `Link` component. The route path argument type is automatically inferred from your routes without any sort of code generation.

```tsx
const navigate = useNavigate();
navigate('/artist/:slug', { params: { slug: 'Nirvana' }})

<Link href="/artist/:slug" params={{ slug: 'Nirvana' }}>Nirvana</Link>
```

#### I18n
If your app supports multiple languages Gemi has a built-in type-safe i18n support where you can create translations per page. When you navigate between pages the required translations will be loaded and cached automatically. 

```tsx

export default function HomePage(props) {
  const t = useTranslator();
  
  return <div>{t('hello')} {props.name}</div>
}

```

#### Logging
```tsx
Log.info('User logged in', { user })
```

And more...

