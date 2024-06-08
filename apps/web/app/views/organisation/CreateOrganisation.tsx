import {
  Link,
  useRouter,
  FormError,
  Mutation,
  ValidationErrors,
} from "gemi/client";

import {
  Input,
  Spacer,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Button,
} from "@nextui-org/react";

export default function CreateOrganisation() {
  const { push } = useRouter();
  return (
    <div>
      <div className="container max-w-md mx-auto h-dvh flex flex-col justify-center">
        <div>
          <Card>
            <CardHeader>Create organisation</CardHeader>
            <CardBody>
              <Mutation
                onSuccess={({ organisation }) => {
                  push(`/organisation/${organisation.id}/dashboard`);
                }}
                url="/organisation"
              >
                <Input name="name" label="Organisation name" />
                <ValidationErrors
                  name="name"
                  className="text-red-400 text-sm px-3 pt-4"
                />
                <Spacer y={3} />

                <FormError className="text-red-400 text-sm px-3 pt-4" />
                <Divider className="my-4" />
                <div className="flex justify-between">
                  <div>
                    <span>
                      Do you have an organisation? <br />{" "}
                      <Link
                        className="text-sm font-semibold"
                        href="/organisation/join"
                      >
                        Join
                      </Link>
                    </span>
                  </div>
                  <div>
                    <Button type="submit" color="primary">
                      <span>Create</span>
                    </Button>
                  </div>
                </div>
              </Mutation>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
