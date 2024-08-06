import {
  Form,
  FormError,
  useRouter,
  useSearchParams,
  useUser,
  ValidationErrors,
} from "gemi/client";
import { useEffect } from "react";

export default function SignIn() {
  const { push } = useRouter();
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useUser();

  useEffect(() => {
    if (user) {
      push("/app/dashboard");
    }
  }, [user]);

  return (
    <div>
      <button
        onClick={() =>
          setSearchParams((s) => {
            s.set("test", "test");
            return s;
          })
        }
      >
        Update
      </button>
      <Form
        pathPrefix="/auth"
        action="POST:/sign-in"
        onSuccess={() => push("/app/dashboard")}
      >
        <div>
          <input
            type="email"
            defaultValue={searchParams.get("email") ?? ""}
            name="email"
            placeholder="Email"
          />
          <ValidationErrors name="email" />
        </div>
        <div>
          <input
            type="password"
            defaultValue={searchParams.get("test") ?? ""}
            name="password"
            placeholder="Password"
          />
          <ValidationErrors name="password" />
        </div>
        <button type="submit">
          Sign In{" "}
          <span className="hidden group-data-[loading=true]:inline">...</span>
        </button>
        <FormError />
      </Form>
      <div>
        <a href="/auth/sign-up">Sign Up</a>
      </div>
    </div>
  );
}
