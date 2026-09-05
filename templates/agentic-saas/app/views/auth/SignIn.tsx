import { Form, Link, useNavigate, ValidationErrors } from "gemi/client";
import { LifeBuoyIcon } from "lucide-react";
import { Button } from "@/app/views/components/ui/button";
import { Input } from "@/app/views/components/ui/input";

export default function SignIn() {
  const { push } = useNavigate();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <LifeBuoyIcon className="size-6 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">Sign in to open the support agent.</p>
        </div>

        {/* `/auth/sign-in-v2` rather than `/auth/sign-in`: both check the password the
            same way, but v2 runs `extendSession`, so whatever the app hangs off a
            session in `config/auth.ts` is there on the very first request. */}
        <Form
          method="POST"
          action="/auth/sign-in-v2"
          onSuccess={() => push("/chat")}
          className="flex flex-col gap-5 rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xs"
        >
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

          {/* Its own key, not a field error: a wrong password is not attached to the
              email input or the password input, and guessing which would tell an
              attacker which half they got right. */}
          <ValidationErrors
            name="invalid_credentials"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          />

          <Button type="submit" className="w-full">
            Sign in
          </Button>
        </Form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          No account yet?{" "}
          <Link href="/auth/sign-up" className="font-medium text-foreground hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
