import { Link, useScopedTranslator, type ViewProps } from "gemi/client";

export default function Home(props: ViewProps<"/">) {
  const st = useScopedTranslator("view:/");

  return (
    <div>
      <div>{st("hi", { name: "Enes" })}</div>
      <div>
        <Link href="/:testId" params={{ testId: "hi-enes" }}>
          HI ENES
        </Link>
      </div>
    </div>
  );
}
