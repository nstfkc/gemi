import {
  Form,
  FormError,
  Link,
  useNavigate,
  useSearchParams,
  useUser,
  ValidationErrors,
} from "gemi/client";
import { useEffect } from "react";

export default function SignIn() {
  const { push } = useNavigate();
  const searchParams = useSearchParams();
  const user = useUser();

  useEffect(() => {
    if (user) {
      push("/hello");
    }
  }, [user]);

  return (
    <div className="container max-w-sm mx-auto h-screen flex flex-col justify-center items-center">
      <Form
        action="POST:/auth/sign-in"
        onSuccess={() => push("/app/dashboard")}
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
            >
              Sign In{" "}
              <span className="hidden group-data-[loading=true]:inline">
                ...
              </span>
            </button>
          </div>
        </div>
        <FormError />
      </Form>
    </div>
  );
}
