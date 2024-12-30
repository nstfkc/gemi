
## Creating an email template

```ts

class WelcomeEmail extends Email {
  subject = 'Welcome'
  from = 'Noreply <noreply@example.com>'

  template = (props: { name: string }) => {
    return (
      <Html lang="en">
        <Text>Welcome {props.name}</Text>
      </Html>
    )
  }
}

```

## Sending emails

```ts

await WelcomeEmail.send({ 
. to: ['john@example.com'],
    data: {
    name: 'John' 
  } 
})

```

