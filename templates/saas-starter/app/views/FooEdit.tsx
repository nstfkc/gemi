import { Form, usePut, useQuery } from "gemi/client";

export default function FooEdit() {
  const { data } = useQuery("/foo/:id");
  console.log({ data });
  return (
    <div>
      Foo edit {data?.id}
      <div>
        <Form method="PUT" action="/foo/:id">
          <button>Edit</button>
        </Form>
      </div>
    </div>
  );
}
