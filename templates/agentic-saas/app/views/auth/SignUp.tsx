import { Form, FormError, Link, useNavigate, ValidationErrors } from "gemi/client";
import { LifeBuoyIcon } from "lucide-react";
import { Button } from "@/app/views/components/ui/button";
import { Input } from "@/app/views/components/ui/input";

export default function SignUp() {
  const { replace } = useNavigate();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <LifeBuoyIcon className="size-6 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
          <p className="text-sm text-muted-foreground">
            The chat and its threads belong to a user, so there has to be one.
          </p>
        </div>

        {/* `replace`, not `push`: sign-up does not sign you in, and leaving this page
            in the history means the back button lands on a form that will now fail
            with an email that is already taken. */}
        <Form
          method="POST"
          action="/auth/sign-up"
          onSuccess={() => replace("/auth/sign-in")}
          className="flex flex-col gap-5 rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xs"
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="name" className="text-sm font-medium">
              Name
            </label>
            <Input id="name" name="name" placeholder="Ada Lovelace" />
            <ValidationErrors name="name" className="text-sm text-destructive" />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input id="email" name="email" type="email" placeholder="you@example.com" />
            <ValidationErrors name="email" className="text-sm text-destructive" />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input id="password" name="password" type="password" placeholder="••••••••" />
            <ValidationErrors name="password" className="text-sm text-destructive" />
          </div>

          <FormError className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" />

          <Button type="submit" className="w-full">
            Create account
          </Button>
        </Form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have one?{" "}
          <Link href="/auth/sign-in" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
