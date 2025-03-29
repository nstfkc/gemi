import { Form, FormError, Link, useNavigate } from "gemi/client";
import { Input } from "../components/ui/input";
import { FormField } from "../components/FormField";
import { Button } from "../components/ui/button";

export default function SignUp() {
  const { replace } = useNavigate();
  return (
    <div className="container max-w-sm mx-auto h-screen flex flex-col justify-center items-center">
      <Form
        method="POST"
        action="/auth/sign-up"
        className="flex flex-col gap-8 w-full"
        onSuccess={() => {
          replace("/auth/sign-in");
        }}
      >
        <FormField name="name" label="Name">
          <Input id="name" name="name" placeholder="Name" />
        </FormField>
        <FormField name="email" label="Email">
          <Input id="email" type="email" name="email" placeholder="Email" />
        </FormField>
        <FormField name="password" label="Password">
          <Input type="password" name="password" placeholder="Password" />
        </FormField>

        <div className="flex justify-between items-center py-4">
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
            <Button type="submit">Sign Up</Button>
          </div>
        </div>
        <FormError />
      </Form>
    </div>
  );
}
