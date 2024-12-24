import {
  Form,
  Link,
  useNavigate,
  useSearchParams,
  useUser,
  ValidationErrors,
} from "gemi/client";
import { useState } from "react";

export default function SignIn() {
  const { push } = useNavigate();
  const searchParams = useSearchParams();
  const { loading } = useUser();

  if (loading) {
    return <div>...</div>;
  }

  return (
    <div className="container max-w-sm mx-auto h-screen flex flex-col justify-center items-center">
      <Form
        method="POST"
        action="/auth/sign-in"
        onSuccess={() => push("/app/dashboard")}
        onError={(error) => {
          console.log({ error });
        }}
        className="flex flex-col gap-4 w-full"
      >
        <div className="flex flex-col">
          <label htmlFor="email">Email</label>
          <input
            className="bg-slate-50 p-1 rounded-md"
            id="email"
            type="email"
            defaultValue={searchParams.get("email") ?? ""}
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
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm">
              You don&apos;t have an account?
              <br />
              <Link className="font-semibold" href="/auth/sign-up">
                Sign Up
              </Link>
            </p>
          </div>
          <div>
            <button
              className="bg-slate-800 shrink-0 text-white rounded-lg px-4 py-3"
              type="submit"
              onClick={() => console.log("hi")}
            >
              Sign In{" "}
              <span className="hidden group-data-[loading=true]:inline">
                ...
              </span>
            </button>
          </div>
        </div>
        <ValidationErrors name="invalid_credentials" />
      </Form>
      <div>
        <a href="/oauth/google">Sign In with Google</a>
      </div>
      <div>
        <WithEmail />
      </div>
    </div>
  );
}

const WithEmail = () => {
  const [email, setEmail] = useState<null | string>(null);
  const navigate = useNavigate();

  if (email) {
    return (
      <Form
        method="POST"
        action="/auth/sign-in-with-pin"
        onSuccess={() => {
          navigate.replace("/app/dashboard");
        }}
      >
        <input name="email" defaultValue={email} type="hidden" />
        <input name="pin" />
        <div>
          <button>Sign in</button>
        </div>
      </Form>
    );
  }
  return (
    <Form
      method="POST"
      action="/auth/magic-link"
      onSuccess={(data) => {
        console.log({ data });
        setEmail(data.email);
      }}
    >
      <input name="email" />
      <div>
        <button>Continue with email</button>
      </div>
    </Form>
  );
};
