import { Link, useRouter } from "gemi/client";
import { FormError, Mutation } from "gemi/client";

import {
  Input,
  Spacer,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Button,
} from "@nextui-org/react";

export default function SignIn() {
  const { push } = useRouter();
  return (
    <div>
      <div className="container max-w-md mx-auto h-dvh flex flex-col justify-center">
        <div>
          <Card>
            <CardHeader>Sign In</CardHeader>
            <CardBody>
              <Mutation
                onSuccess={({ user }) => {
                  if (user.accounts.length > 0) {
                    push(
                      `/organisation/${user.accounts[0].organizationId}/dashboard`,
                    );
                  } else {
                    push("/organisation/create");
                  }
                }}
                url="/auth/sign-in"
              >
                <Input name="email" type="email" label="Email" />
                <Spacer y={3} />
                <Input type="password" name="password" label="Password" />

                <FormError className="text-red-400 text-sm px-3 pt-4" />
                <Divider className="my-4" />
                <div className="flex justify-between">
                  <div>
                    <span>
                      You don&apos;t have an account? <br />{" "}
                      <Link
                        className="text-sm font-semibold"
                        href="/auth/sign-up"
                      >
                        Sign up
                      </Link>
                    </span>
                  </div>
                  <div>
                    <Button type="submit" color="primary">
                      <span>Sign In</span>
                    </Button>
                  </div>
                </div>
              </Mutation>
            </CardBody>
          </Card>
          <div className="px-2">
            <Spacer y={2} />
            <Link
              href="/auth/forgot-password"
              className="text-sm font-semibold"
            >
              Forgot password?
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
