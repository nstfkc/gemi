import { Link, useRouter, useSearchParams, type ViewProps } from "gemi/client";

export default function Home(props: ViewProps<"/">) {
  const [searchParams, setSearchParams] = useSearchParams();
  console.log("render");
  return (
    <div>
      <h1>Home</h1>
      <div>{props.message}</div>
      <Link params={{ testId: "1234" }} href="/:testId">
        Helo
      </Link>
      <div>
        <pre>{searchParams.toString()}</pre>
      </div>
      <button
        onClick={() =>
          setSearchParams((params) => {
            params.set("test", "1234");
            return params;
          }, true)
        }
      >
        Push
      </button>
      <button
        onClick={() =>
          setSearchParams((params) => {
            params.delete("test");
            return params;
          })
        }
      >
        Remove
      </button>
    </div>
  );
}
