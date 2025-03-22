Baterries included full-stack web framework designed for developers who enjoys life more than discussing which library is better with strangers on the internet.

Gemi provides a full set of features every web application possibly needs. Such as authentication and authorization, routing, route level middleware, type-safe data fetching and mutations, form validations,sending emails, background tasks, object storage and more.

By using Gemi, you will relieve yourself from the duty of constantly finding the best libraries for your stack and have more time for your friends and your family.


## Why/When you should use Gemi?
Even though you can build any kind of web application with Gemi, due to its nature it is a better fit for B2B apps where you need to create too many api endpoints with a relatively complex business logic. If you are building a static website, blog or an e-commerce application, nextjs or astro might be better fit because they can provide better results at initial load.


## Features

### Config based routing

Creating Api routes

``` typescript
import { ApiRouter, HttpRequest } from "gemi/http";

export default class extends ApiRouter {
  routes = {
    "/orders": this.get(async () => {
      return await db.orders.findAll();
    }),
    "/orders/:orderId": this.get(async (req: HttpRequest) => {
      return await db.orders.findOne({ where: { id: req.params.orderId } });
    }),
  };
}
```

Creating view routes (web pages)

``` typescript
import { ViewRouter } from 'gemi/http'

export default class extends ViewRouter {
  routes = {
    "/": this.view('Home'),
    "/about": this.view('About'),
  }
}
```


### Authentication and authorization

Access to the authenticated user information

``` typescript
import { ApiRouter, HttpRequest } from "gemi/http"
import { Auth } from "gemi/facades"

export default class extends ApiRouter {
  middleware = ['auth']
  routes = {
    "/my-orders": this.get(async () => {
      const user = await Auth.user()
      return await db.orders.findAll({ where: { receiverId: user.id } })
    }),
  }
}
```

Authorize a user using `Form` component

``` tsx
import { Form, useNavigate } from "gemi/client"

export default function SignIn() {
  const { push } = useNavigate()
  return (
    <Form
      method="POST"
      action="/auth/sign-in"
      onSuccess={() => push("/dashboard")}
      onError={(error) => console.error(error)}
    >
      ...
    </Form>
  );
}
```



### Type-safe network layer

Consuming api endpoints using `useGet` hook.

``` tsx
import { useGet } from 'gemi/client'

export default function OrderDetail() {
  const { data: orders } = useGet('/orders/:orderId')

  return (
    <div>...</div>
  )
}
```


### Sending emails

Creating an email template and sending it.

``` tsx
import { Email } from "gemi/email"
import { Text, Body, Container } from "jsx-email"

export class WelcomeEmail extends Email {
  from = "Gemi <updates@gemijs.dev>"
  subject = "Welcome to Gemi!"

  template = ({ name }: { name: string }) => (
    <Body>
      <Container>
        <Text>Hello {name},</Text>
        <Text>Welcome to Gemi! We're excited to have you on board.</Text>
      </Container>
    </Body>
  )
}

// Laterin the codebase, you can send this email like so:

await Email.send({ data: { name: 'John' }, to: ['johndoe@gemijs.dev'] })
```


### Object storage

Storing a file to object storage (S3) and retrieving it.

``` typescript
import { FileStorage } from "gemi/facades";
import { ApiRouter, HttpRequest } from "gemi/http";

export default class extends ApiRouter {
  routes = {
    "/upload": this.post(async (req: HttpRequest) => {
      const input = await req.input();
      const file = input.get("file");
      const src = await FileStorage.put(file);

      return { src }
    }),
    "/file/:src*": this.get(async (req: HttpRequest) => {
      return await FileStorage.fetch(req.params.src);
    }),
  };
}
```


### Async jobs

Creating a async job for time consuming jobs

``` typescript
import { Job } from "gemi/services";

export class ProcessVideoJob extends Job {
  static name = 'ProcessVideo'

  async run(params: { videoId: number }) {
    // Process video file
  }

  async onError(error: Error) {
    // Handle error
  }

  async onSuccess() {
    // Notify user
  }
}

// Later in your code
Job.dispatch({videoId: 1 });

```
