import { Form, Link, useScopedTranslator, type ViewProps } from "gemi/client";

export default function Home(props: ViewProps<"/">) {
  const st = useScopedTranslator("view:/");

  return (
    <div>
      <div>{st("hi", { name: "Enes" })}</div>
      <div>
        <Link
          href="/:testId"
          search={{ foo: "bar" }}
          params={{ testId: "hi-enes" }}
        >
          HI ENES
        </Link>
        <Form action="POST:/users/:id" params={{ id: 1 }}></Form>
      </div>
    </div>
  );
}
