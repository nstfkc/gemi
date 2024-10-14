import { Form, usePut } from "gemi/client";

export default function FooEdit() {
  return (
    <div>
      Foo edit
      <div>
        <Form method="PUT" action="/foo/:id">
          <button>Edit</button>
        </Form>
      </div>
    </div>
  );
}
