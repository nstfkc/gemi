import { Form, Link, useIntendedUrl, useNavigate, ValidationErrors } from "gemi/client";
import { FormField } from "../components/FormField";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";

export default function SignIn() {
  const { push } = useNavigate();
  // The page the `auth` middleware turned the visitor away from, if any.
  const intended = useIntendedUrl("/dashboard");

  return (
    <div className="container max-w-sm mx-auto h-screen flex flex-col justify-center items-center">
      <Form
        method="POST"
        action="/auth/sign-in-v2"
        onSuccess={() => push(intended)}
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
      {/* Forwarded so the OAuth callback can return there too. */}
      <a href={`/auth/oauth/google?redirect=${encodeURIComponent(intended)}`}>
        Sign in with google
      </a>
    </div>
  );
}
