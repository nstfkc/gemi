import {
  Form,
  FormError,
  Link,
  useNavigate,
  useSearchParams,
  ValidationErrors,
} from "gemi/client";
import { useState } from "react";

export default function SignUp() {
  const { replace } = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const searchParams = useSearchParams();
  return (
    <div className="container max-w-sm mx-auto h-screen flex flex-col justify-center items-center">
      <div>
        {email && (
          <Form
            method="POST"
            action="/auth/sign-in-with-pin"
            onSuccess={() => {
              replace("/app/dashboard");
            }}
          >
            <input type="hidden" name="email" defaultValue={email} />
            <input name="pin" />
            <div>
              <button>Submit</button>
            </div>
          </Form>
        )}
      </div>
      <Form
        method="POST"
        action="/auth/sign-up"
        className="flex flex-col gap-4 w-full"
        onSuccess={({ email }) => {
          setEmail(email);
        }}
      >
        <input
          type="hidden"
          name="invitationId"
          defaultValue={searchParams.get("invitationId")!}
        />
        <div className="flex flex-col">
          <label htmlFor="name">Name</label>
          <input
            className="bg-slate-50 p-1 rounded-md"
            id="name"
            type="name"
            name="name"
            placeholder="Name"
          />
          <ValidationErrors name="name" />
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
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm">
              Do you have an account?
              <br />
              <Link className="font-semibold" href="/auth/sign-in">
                Sign In
              </Link>
            </p>
          </div>
          <div>
            <button
              className="bg-slate-800 shrink-0 text-white rounded-lg px-4 py-3"
              type="submit"
            >
              Sign Up{" "}
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
