import { Form, FormError, useRouter, ValidationErrors } from "gemi/client";

export default function SignUp() {
  const { push } = useRouter();
  return (
    <Form
      pathPrefix="/auth"
      action="POST:/sign-up"
      onSuccess={({ user }) => push(`/auth/sign-in?email=${user.email}`)}
    >
      <div>
        <input type="name" name="name" placeholder="Name" />
        <ValidationErrors name="name" />
      </div>
      <div>
        <input type="email" name="email" placeholder="Email" />
        <ValidationErrors name="email" />
      </div>
      <div>
        <input type="password" name="password" placeholder="Password" />
        <ValidationErrors name="password" />
      </div>
      <button type="submit">
        Sign Up
        <span className="hidden group-data-[loading=true]:inline">...</span>
      </button>
      <FormError />
    </Form>
  );
}
