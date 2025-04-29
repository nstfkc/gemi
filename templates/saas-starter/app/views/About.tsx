import { useTranslator, type ViewProps } from "gemi/client";

export default function About(props: ViewProps<"/about">) {
  const x = useTranslator("About");
  return (
    <div className="h-dvh">
      <h1>{props.title}</h1>
      <div>{x.jsx("title", { version: (v) => <strong>{v}</strong> })}</div>
      <div>
        <p>{x.jsx("para", { break: () => <br /> })}</p>
      </div>
    </div>
  );
}
