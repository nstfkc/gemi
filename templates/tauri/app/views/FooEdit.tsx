import { Form, useMutation, usePut, useQuery } from "gemi/client";

export default function FooEdit() {
  const { data } = useQuery("");
  console.log({ data });
  return (
    <div>
      Foo edit {data?.id}
      <div>
        <Form method="PUT" action="/foo/:fooId">
          <button>Edit</button>
        </Form>
      </div>
    </div>
  );
}
