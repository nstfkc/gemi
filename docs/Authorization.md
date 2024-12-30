Here is an example how  a sign in form looks like.
```tsx

export default function SignIn() {
  const navigate = useNavigation()
  
  return (
	<div>
	  <Form 
		onSuccess={() => navigate.replace('/app/dashboard')} 
		method="POST" 
		action="/auth/sign-in"
	  >	
		<input name="email" />
		<input name="password" type="password"/>
        <button>Submit</button>
	  </Form>
	  <div>
		 <Link href="/auth/oauth/google">
		   Continue with Google
		 </Link>
	  </div>
	</div>
  )
}

```