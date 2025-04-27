import { useTranslator, type ViewProps } from "gemi/client";

export default function About(props: ViewProps<"/about">) {
  const x = useTranslator("About");
  return (
    <div className="h-dvh">
      <h1>{props.title}</h1>
      <div>{x("title")}</div>
    </div>
  );
}
