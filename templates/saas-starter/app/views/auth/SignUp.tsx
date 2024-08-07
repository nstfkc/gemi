import { Form, FormError, useRouter, ValidationErrors } from "gemi/client";

export default function SignUp() {
  const { push } = useRouter();
  return (
    <Form
      pathPrefix="/auth"
      action="POST:/sign-up"
      onSuccess={({ user }) => push(`/auth/sign-in?email=${user.email}`)}
    >
      <div className="flex flex-col">
        <label htmlFor="name">Name</label>
        <input
          className="bg-slate-50 p-1 rounded-md"
          id="name"
          type="name"
          name="name"
          placeholder="Name"
        />
        <ValidationErrors name="email" />
      </div>
      <div className="flex flex-col">
        <label htmlFor="email">Email</label>
        <input
          className="bg-slate-50 p-1 rounded-md"
          id="email"
          type="email"
          name="email"
          placeholder="Email"
        />
        <ValidationErrors name="email" />
      </div>

      <div className="flex flex-col">
        <label htmlFor="password">Password</label>
        <input
          className="bg-slate-50 p-1 rounded-md"
          type="password"
          name="password"
          placeholder="Password"
        />
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
