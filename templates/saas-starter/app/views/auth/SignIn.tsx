import { Form, Link, useNavigate, ValidationErrors } from "gemi/client";
import { FormField } from "../components/FormField";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";

export default function SignIn() {
  const { push } = useNavigate();

  return (
    <div className="container max-w-sm mx-auto h-screen flex flex-col justify-center items-center">
      <Form
        method="POST"
        action="/auth/sign-in-v2"
        onSuccess={() => push("/dashboard")}
        className="flex flex-col gap-8 w-full"
      >
        <FormField name="email" label="Email">
          <Input id="email" type="email" name="email" placeholder="Email" />
        </FormField>
        <FormField name="password" label="Password">
          <Input type="password" name="password" placeholder="Password" />
        </FormField>

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
            <Button type="submit">Sign In</Button>
          </div>
        </div>
        <ValidationErrors name="invalid_credentials" />
      </Form>
      <a href="/auth/oauth/google">Sign in with google</a>
    </div>
  );
}
