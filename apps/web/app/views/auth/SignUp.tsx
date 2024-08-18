import { Mutation, ValidationErrors, Link, useRouter } from "gemi/client";

import {
  Input,
  Spacer,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Button,
} from "@nextui-org/react";

export default function SignUp() {
  const { push } = useNavigate();
  return (
    <div>
      <div className="container max-w-md mx-auto h-dvh flex flex-col justify-center">
        <div>
          <Card>
            <CardHeader>Sign Up</CardHeader>
            <CardBody>
              <Mutation
                onSuccess={() => {
                  push("/auth/sign-in");
                }}
                url="/auth/sign-up"
              >
                <Input name="name" label="Name" />
                <ValidationErrors
                  className="text-sm text-red-400 px-3"
                  name="name"
                />
                <Spacer y={4} />
                <Input type="email" name="email" label="Email" />
                <ValidationErrors
                  className="text-sm text-red-400 px-3"
                  name="email"
                />
                <Spacer y={4} />
                <Input type="password" name="password" label="Password" />
                <ValidationErrors
                  className="text-sm text-red-400 px-3"
                  name="password"
                />
                <Divider className="my-4" />
                <div className="flex justify-between">
                  <div>
                    <span>
                      Do you have an account? <br />{" "}
                      <Link
                        className="text-sm font-semibold"
                        href="/auth/sign-in"
                      >
                        Sign in
                      </Link>
                    </span>
                  </div>
                  <button type="submit" color="primary">
                    Sign Up
                  </button>
                </div>
              </Mutation>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
