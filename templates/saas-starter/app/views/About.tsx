import {
  useLocale,
  useQuery,
  useTranslator,
  type ViewProps,
} from "gemi/client";

export default function About(props: ViewProps<"/about">) {
  const x = useTranslator("About");
  const [locale] = useLocale();
  const { data } = useQuery("/test", {
    search: { locale },
  });
  return (
    <div className="h-dvh">
      <h1>
        {props.title} {data?.message ?? "Loading..."}
      </h1>
      <div>{x.jsx("title", { version: (v) => <strong>{v}</strong> })}</div>
      <div>
        <p>{x.jsx("para", { break: () => <br /> })}</p>
      </div>
    </div>
  );
}
