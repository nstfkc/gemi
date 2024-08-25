import {
  Form,
  Link,
  useDelete,
  useMutation,
  usePatch,
  usePost,
  useQuery,
  useSearchParams,
  useUser,
  type ViewProps,
} from "gemi/client";

export default function Home(props: ViewProps<"/">) {
  const searchParams = useSearchParams();

  const {
    data: colors,
    mutate,
    loading,
  } = useQuery(
    "/home",
    {
      search: { color: searchParams.get("color") },
    },
    { keepPreviousData: true },
  );

  return (
    <div>
      <div className="flex gap-2">
        {props.filters.map((filter) => (
          <Link
            key={filter}
            className="data-[active=true]:underline"
            href="/"
            search={{ color: filter }}
          >
            {filter}
          </Link>
        ))}
      </div>

      <Form action="/shop/:shopId/host" params={{ shopId: "1234" }}></Form>
      <div>Test</div>
      <div>
        {colors?.map((color) => (
          <div
            key={color.hex}
            style={{ backgroundColor: color.hex, width: 100, height: 100 }}
          />
        ))}
      </div>
      <button
        onClick={() => {
          mutate([
            {
              id: 5,
              name: "Purple",
              hex: "#800080",
              color: "purple",
            },
          ]);
        }}
      >
        Mutate
      </button>
    </div>
  );
}
